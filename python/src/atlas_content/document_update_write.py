"""Bounded Windows NTFS transaction writer. No fallback writes.

Win32 call order was checked against pywin32's public TxF example (commit
9f88183224af4a9c127c0d6d1b3c7d4846124171); this is an independent ctypes binding.
"""
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import ntpath
import os
import re
import sys

LIMIT = 256 * 1024
INVALID = c.c_void_p(-1).value


def run(request):
    if sys.platform != 'win32':
        raise ValueError('Transactional Document Update requires Windows NTFS.')
    k = c.WinDLL('kernel32', use_last_error=True)
    ktm = c.WinDLL('KtmW32', use_last_error=True)

    def bind(dll, name, args, result):
        fn = getattr(dll, name); fn.argtypes = args; fn.restype = result
        return fn

    close = bind(k, 'CloseHandle', [w.HANDLE], w.BOOL)
    plain = bind(k, 'CreateFileW', [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE)
    transacted = bind(k, 'CreateFileTransactedW', [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE, w.HANDLE, c.c_void_p, c.c_void_p], w.HANDLE)
    create = bind(ktm, 'CreateTransaction', [c.c_void_p, c.c_void_p, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.LPWSTR], w.HANDLE)
    commit = bind(ktm, 'CommitTransaction', [w.HANDLE], w.BOOL)
    rollback = bind(ktm, 'RollbackTransaction', [w.HANDLE], w.BOOL)
    final = bind(k, 'GetFinalPathNameByHandleW', [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD], w.DWORD)
    volume = bind(k, 'GetVolumeInformationByHandleW', [w.HANDLE, w.LPWSTR, w.DWORD, c.POINTER(w.DWORD), c.POINTER(w.DWORD), c.POINTER(w.DWORD), w.LPWSTR, w.DWORD], w.BOOL)
    read = bind(k, 'ReadFile', [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL)
    write = bind(k, 'WriteFile', [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL)
    seek = bind(k, 'SetFilePointerEx', [w.HANDLE, c.c_longlong, c.POINTER(c.c_longlong), w.DWORD], w.BOOL)
    eof = bind(k, 'SetEndOfFile', [w.HANDLE], w.BOOL)
    flush = bind(k, 'FlushFileBuffers', [w.HANDLE], w.BOOL)

    class Info(c.Structure):
        _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME),
                    ('modified', w.FILETIME), ('volume', w.DWORD), ('size_high', w.DWORD),
                    ('size_low', w.DWORD), ('links', w.DWORD), ('index_high', w.DWORD), ('index_low', w.DWORD)]
    info_call = bind(k, 'GetFileInformationByHandle', [w.HANDLE, c.POINTER(Info)], w.BOOL)

    def checked(value, operation):
        if not value or value == INVALID:
            error = c.get_last_error()
            raise OSError(error, f'{operation}: {c.FormatError(error).strip()}')
        return value

    def canonical(value):
        if not isinstance(value, str) or not re.match(r'^[A-Za-z]:\\', value) or '/' in value or '\x00' in value:
            raise ValueError('Only canonical local drive paths are supported.')
        parts = value[3:].split('\\')
        if any(not p or p in ('.', '..') or p.endswith((' ', '.')) or ':' in p or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I) for p in parts):
            raise ValueError('Path aliases, streams and devices are refused.')
        return value

    def evidence(handle, expected_path, directory=False):
        data = Info(); checked(info_call(handle, c.byref(data)), 'File information')
        if data.attributes & 0x400 or bool(data.attributes & 0x10) != directory:
            raise ValueError('Reparse points and non-regular targets are refused.')
        name = c.create_unicode_buffer(32768)
        length = checked(final(handle, name, len(name), 0), 'Final path')
        if length >= len(name) or name.value.casefold() != ('\\\\?\\' + expected_path).casefold():
            raise ValueError('Final path does not match the declared path.')
        return data

    mode = request.get('mode')
    if mode not in ('inspect', 'replace'):
        raise ValueError('Unknown writer mode.')
    root = canonical(request.get('root'))
    target = canonical(request.get('target'))
    if not target.casefold().startswith(root.casefold() + '\\'):
        raise ValueError('Target is outside the declared root.')
    guards = []; tx = handle = None; committed = False
    try:
        # Lock every directory from the volume root to the target parent.
        drive = target[:3]
        parents = [drive]
        for part in target[3:].split('\\')[:-1]:
            parents.append(ntpath.join(parents[-1], part))
        for parent in parents:
            guard = checked(plain(parent, 0x80000000, 1, None, 3, 0x02200000, None), 'Directory ownership')
            guards.append(guard); evidence(guard, parent, True)
        fs_name = c.create_unicode_buffer(32)
        checked(volume(guards[0], None, 0, None, None, None, fs_name, len(fs_name)), 'Volume capability')
        if fs_name.value != 'NTFS':
            raise ValueError('Transactional Document Update requires NTFS.')
        tx = checked(create(None, None, 0, 0, 0, 15000, 'Atlas Document Update'), 'CreateTransaction')
        handle = checked(transacted(target, 0xC0000000, 1, None, 3, 0x00200000, None, tx, None, None), 'Transactional ownership')
        data = evidence(handle, target)
        if data.links != 1 or data.size_high or data.size_low > LIMIT:
            raise ValueError('Hard links and oversized targets are refused.')
        file_id = f'{data.volume:08x}:{data.index_high:08x}{data.index_low:08x}'
        if request.get('expectedFileId') is not None and request['expectedFileId'] != file_id:
            raise ValueError('Document file identity changed.')
        buffer = c.create_string_buffer(LIMIT + 1); count = w.DWORD()
        checked(read(handle, buffer, LIMIT + 1, c.byref(count), None), 'Read owned file')
        body = buffer.raw[:count.value]
        if len(body) > LIMIT:
            raise ValueError('Document exceeds its byte limit.')
        text = body.decode('utf-8', errors='strict')
        digest = hashlib.sha256(body).hexdigest()
        if request.get('expectedSha256') is not None and request['expectedSha256'] != digest:
            raise ValueError('Document hash changed.')
        if mode == 'replace':
            if not request.get('expectedFileId') or not request.get('expectedSha256') or not isinstance(request.get('text'), str):
                raise ValueError('Replacement requires identity, hash and complete text.')
            text = request['text']; body = text.encode('utf-8')
            if len(body) > LIMIT:
                raise ValueError('Replacement exceeds its byte limit.')
            checked(seek(handle, 0, None, 0), 'Seek owned file')
            checked(write(handle, c.create_string_buffer(body), len(body), c.byref(count), None), 'Write complete document')
            if count.value != len(body):
                raise OSError('Short transactional write')
            checked(eof(handle), 'Truncate owned file'); checked(flush(handle), 'Flush owned file')
            checked(seek(handle, 0, None, 0), 'Verify seek')
            verified = c.create_string_buffer(LIMIT + 1)
            checked(read(handle, verified, LIMIT + 1, c.byref(count), None), 'Verify owned result')
            if verified.raw[:count.value] != body:
                raise OSError('Transactional result verification failed')
            digest = hashlib.sha256(body).hexdigest()
            checked(close(handle), 'Close owned file'); handle = None
            checked(commit(tx), 'CommitTransaction'); committed = True
        return {'ok': True, 'file_id': file_id, 'sha256': digest, 'bytes': len(body), 'text': text}
    finally:
        if handle: close(handle)
        if tx:
            if not committed: rollback(tx)
            close(tx)
        for guard in reversed(guards): close(guard)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Writer request exceeds its limit.')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
