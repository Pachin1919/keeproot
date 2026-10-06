"""Bounded same-volume NTFS directory move. No fallback filesystem writes."""
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import ntpath
import os
import re
import sys

MAX_ENTRIES = 4096
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_BYTES = 256 * 1024 * 1024
INVALID = c.c_void_p(-1).value


def run(request):
    if os.name != 'nt':
        raise ValueError('Project Move requires Windows NTFS transactions.')
    k = c.WinDLL('kernel32', use_last_error=True)
    ktm = c.WinDLL('KtmW32', use_last_error=True)

    def bind(dll, name, args, result):
        fn = getattr(dll, name); fn.argtypes = args; fn.restype = result
        return fn

    plain = bind(k, 'CreateFileW', [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE)
    opened = bind(k, 'CreateFileTransactedW', [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE, w.HANDLE, c.c_void_p, c.c_void_p], w.HANDLE)
    close = bind(k, 'CloseHandle', [w.HANDLE], w.BOOL)
    create = bind(ktm, 'CreateTransaction', [c.c_void_p, c.c_void_p, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.LPWSTR], w.HANDLE)
    commit = bind(ktm, 'CommitTransaction', [w.HANDLE], w.BOOL)
    rollback = bind(ktm, 'RollbackTransaction', [w.HANDLE], w.BOOL)
    move = bind(k, 'MoveFileTransactedW', [w.LPCWSTR, w.LPCWSTR, c.c_void_p, c.c_void_p, w.DWORD, w.HANDLE], w.BOOL)
    final = bind(k, 'GetFinalPathNameByHandleW', [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD], w.DWORD)
    volume = bind(k, 'GetVolumeInformationByHandleW', [w.HANDLE, w.LPWSTR, w.DWORD, c.POINTER(w.DWORD), c.POINTER(w.DWORD), c.POINTER(w.DWORD), w.LPWSTR, w.DWORD], w.BOOL)
    read = bind(k, 'ReadFile', [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL)

    class Info(c.Structure):
        _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME), ('modified', w.FILETIME), ('volume', w.DWORD), ('size_high', w.DWORD), ('size_low', w.DWORD), ('links', w.DWORD), ('index_high', w.DWORD), ('index_low', w.DWORD)]

    class FindData(c.Structure):
        _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME), ('modified', w.FILETIME), ('size_high', w.DWORD), ('size_low', w.DWORD), ('reserved0', w.DWORD), ('reserved1', w.DWORD), ('name', w.WCHAR * 260), ('alternate', w.WCHAR * 14)]

    info = bind(k, 'GetFileInformationByHandle', [w.HANDLE, c.POINTER(Info)], w.BOOL)
    first_tx = bind(k, 'FindFirstFileTransactedW', [w.LPCWSTR, c.c_int, c.c_void_p, c.c_int, c.c_void_p, w.DWORD, w.HANDLE], w.HANDLE)
    first = bind(k, 'FindFirstFileW', [w.LPCWSTR, c.c_void_p], w.HANDLE)
    next_file = bind(k, 'FindNextFileW', [w.HANDLE, c.c_void_p], w.BOOL)
    find_close = bind(k, 'FindClose', [w.HANDLE], w.BOOL)

    def checked(value, stage):
        if not value or value == INVALID:
            n = c.get_last_error(); raise OSError(n, stage + ': ' + c.FormatError(n).strip())
        return value

    def canonical(value):
        if not isinstance(value, str) or not re.match(r'^[A-Za-z]:\\', value) or '/' in value or '\x00' in value:
            raise ValueError('Only canonical local drive paths are supported.')
        if value.endswith('\\') and len(value) > 3:
            raise ValueError('Trailing separators are refused.')
        for part in value[3:].split('\\') if len(value) > 3 else []:
            if not part or part in ('.', '..') or part.endswith((' ', '.')) or ':' in part or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I):
                raise ValueError('Path aliases, streams and devices are refused.')
        return value

    def evidence(handle, expected, directory):
        value = Info(); checked(info(handle, c.byref(value)), 'identity')
        if value.attributes & (0x400 | 0x40) or bool(value.attributes & 0x10) != directory:
            raise ValueError('Reparse points and special entries are refused.')
        name = c.create_unicode_buffer(32768)
        length = checked(final(handle, name, len(name), 0), 'final path')
        if length >= len(name) or name.value.casefold().rstrip('\\') != ('\\\\?\\' + expected).casefold().rstrip('\\'):
            raise ValueError('Final path differs from declared path: ' + expected)
        return value

    mode = request.get('mode')
    if mode not in ('inspect', 'move'):
        raise ValueError('Unknown Project Move mode.')
    root = canonical(request.get('root')); source = canonical(request.get('source'))
    guard_target = canonical(request.get('target')) if request.get('target') else source
    target = guard_target if mode == 'move' else source
    for value in (source, guard_target):
        if not value.casefold().startswith(root.casefold().rstrip('\\') + '\\'):
            raise ValueError('Project path escapes its Root.')
    if mode == 'move' and (source.casefold() == target.casefold() or source.casefold().startswith(target.casefold() + '\\') or target.casefold().startswith(source.casefold() + '\\')):
        raise ValueError('Overlapping paths are refused.')
    parents = set()
    for value in (source, guard_target):
        cursor = value[:3]; parents.add(cursor)
        for part in value[3:].split('\\')[:-1]:
            cursor = ntpath.join(cursor, part); parents.add(cursor)
    guards = []; handles = []; tx = None; committed = False
    try:
        ancestors = {}
        for parent in sorted(parents, key=lambda p: (len(p), p.casefold())):
            h = checked(plain(parent, 0x80000000, 3, None, 3, 0x02200000, None), 'guard ancestor')
            guards.append(h); value = evidence(h, parent, True)
            ancestors[parent.casefold()] = f'{value.volume:08x}:{value.index_high:08x}{value.index_low:08x}'
        if request.get('expectedAncestors') is not None and ancestors != request['expectedAncestors']:
            raise ValueError('Project Move ancestor identity changed after preview.')
        fs_name = c.create_unicode_buffer(32)
        checked(volume(guards[0], None, 0, None, None, None, fs_name, len(fs_name)), 'volume')
        if fs_name.value != 'NTFS' or source[:2].casefold() != target[:2].casefold():
            raise ValueError('Only same-volume NTFS Project moves are supported.')
        if mode == 'move':
            tx = checked(create(None, None, 0, 0, 0, 30000, 'Atlas Project Move'), 'transaction')
            checked(move(source, target, None, None, 0, tx), 'stage move')
        result = {}; pending = [('.', True)]; total = 0
        while pending:
            if len(result) + len(pending) > MAX_ENTRIES:
                raise ValueError('Project tree exceeds its entry limit.')
            rel, directory = pending.pop(); item = target if rel == '.' else ntpath.join(target, rel)
            flags = 0x02200000 if directory else 0x00200000
            h = checked(opened(item, 0xC0000000, 7, None, 3, flags, None, tx, None, None) if tx else plain(item, 0x80000000, 1, None, 3, flags, None), 'open tree member')
            handles.append(h); value = evidence(h, item, directory)
            if value.volume != evidence(guards[0], sorted(parents, key=lambda p: (len(p), p.casefold()))[0], True).volume:
                raise ValueError('Project member belongs to another volume.')
            entry = {'kind': 'directory' if directory else 'file', 'identity': f'{value.volume:08x}:{value.index_high:08x}{value.index_low:08x}'}
            if not directory:
                size = (value.size_high << 32) + value.size_low
                if value.links != 1 or size > MAX_FILE_BYTES or total + size > MAX_BYTES:
                    raise ValueError('Hard links or Project byte limits are refused.')
                digest = hashlib.sha256(); size_read = 0; buf = c.create_string_buffer(1024 * 1024); count = w.DWORD()
                while True:
                    checked(read(h, buf, len(buf), c.byref(count), None), 'read member')
                    if not count.value: break
                    digest.update(buf.raw[:count.value]); size_read += count.value
                    if size_read > size or size_read > MAX_FILE_BYTES:
                        raise ValueError('Project member changed or exceeded its limit.')
                if size_read != size: raise ValueError('Project member size changed.')
                total += size; entry.update({'sha256': digest.hexdigest(), 'bytes': size})
            result[rel.replace('\\', '/')] = entry
            if directory:
                data = FindData(); fh = first_tx(ntpath.join(item, '*'), 0, c.byref(data), 0, None, 0, tx) if tx else first(ntpath.join(item, '*'), c.byref(data))
                if fh == INVALID:
                    if c.get_last_error() == 2: continue
                    checked(fh, 'enumerate tree')
                try:
                    while True:
                        if data.name not in ('.', '..'):
                            if data.attributes & (0x400 | 0x40): raise ValueError('Linked or special member is refused.')
                            canonical(ntpath.join(item, data.name))
                            pending.append((ntpath.normpath(ntpath.join(rel, data.name)), bool(data.attributes & 0x10)))
                            if len(result) + len(pending) > MAX_ENTRIES: raise ValueError('Project tree exceeds its entry limit.')
                        if not next_file(fh, c.byref(data)):
                            if c.get_last_error() != 18: checked(False, 'next tree member')
                            break
                finally: find_close(fh)
        result = dict(sorted(result.items()))
        if mode == 'move' and result != request.get('expectedManifest'):
            raise ValueError('Project identity or contents changed after preview.')
        for h in handles: close(h)
        handles = []
        if tx: checked(commit(tx), 'commit move'); committed = True
        return {'ok': True, 'manifest': result, 'ancestors': ancestors, 'bytes': total, 'committed': committed}
    finally:
        for h in handles: close(h)
        if tx:
            if not committed: rollback(tx)
            close(tx)
        for h in guards: close(h)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024: raise ValueError('Project Move request exceeds its limit.')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False)); sys.exit(1)
