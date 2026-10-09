"""Check every reachable Git version before publishing. Never print file bodies."""
import pathlib
import re
import subprocess
import sys

PUBLIC_DOCS = {
    'docs/README.md', 'docs/Atlas V1 产品说明书.md',
    'docs/Atlas V1 使用说明书.md', 'docs/Atlas V1 验收指南.md',
    'docs/Atlas 技术作品与企业评审说明.md',
}

def private_path(name):
    path = pathlib.PurePosixPath(name)
    return (
        name in {'AGENTS.md', 'design-qa.md'}
        or name.startswith(('.atlas/', '.codex/', 'test/.tmp/', '.playwright-cli/',
                            '.agents/skills/test-gap-audit/'))
        or name.startswith('docs/') and name not in PUBLIC_DOCS
        or any(part in {'node_modules', '__pycache__', '.venv', 'venv'} for part in path.parts)
        or path.name in {'auth.json', 'credentials.json', 'secrets.json'}
        or path.name.startswith('.env') and path.name != '.env.example'
        or path.suffix.lower() in {'.sqlite', '.db', '.log', '.pem', '.key', '.pfx', '.p12', '.zip', '.7z'}
    )

PATTERNS = {
    'credential': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})'),
    'personal-machine-path': re.compile(rb'C:[\\/]+Users[\\/]+(?!Public\b|Example\b|Test\b|AtlasUser\b)[A-Za-z0-9_-]+|F:[\\/]+(?:Pachin|Obisidian)', re.I),
    'private-feedback': re.compile('\u64cd\u4f60|\u4f60\u5988|\u5c3c\u739b|\u50bb\u903c|\u9a82\u4f60\u7684|\u70e7\u4e865\u4ebf|\u7528\u6237.*(?:\u62b1\u6028|\u8fb1\u9a82)|\u4ed6\u5988\u7684'.encode()),
}

def git(*args):
    return subprocess.check_output(['git', *args])

def check():
    commits = git('rev-list', '--all').decode().splitlines()
    if not commits:
        raise RuntimeError('No committed public candidate to inspect.')
    objects = {}
    problems = set()
    for commit in commits:
        for row in git('ls-tree', '-r', '-z', commit).split(b'\0'):
            if not row:
                continue
            prefix, rawname = row.split(b'\t', 1)
            name = rawname.decode('utf8')
            mode, kind, oid = prefix.decode().split()
            if private_path(name):
                problems.add(('private-path', name))
            if kind == 'blob':
                objects.setdefault(oid, set()).add(name)
            elif kind == 'commit':
                problems.add(('unreviewed-submodule', name))
        objects.setdefault(commit, set()).add('[commit metadata]')
    # One Git process reads binary objects, including older file versions.
    batch = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for oid, names in objects.items():
            batch.stdin.write((oid + '\n').encode())
            batch.stdin.flush()
            header = batch.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError('Git object lookup failed.')
            remaining = int(header[2])
            chunks = []
            while remaining:
                chunk = batch.stdout.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError('Incomplete Git object.')
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b''.join(chunks)
            if batch.stdout.read(1) != b'\n':
                raise RuntimeError('Invalid Git object framing.')
            for category, pattern in PATTERNS.items():
                if pattern.search(data):
                    problems.update((category, name) for name in names)
    finally:
        batch.stdin.close()
        batch.stdout.close()
        batch.wait(timeout=10)
    for category, name in sorted(problems):
        print(f'{category}: {name}')
    if '--worktree' in sys.argv:
        names = set(git('ls-files', '-z').decode().split('\0')) | set(git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0'))
        for name in sorted(names - {''}):
            file = pathlib.Path(name)
            if not file.is_file():
                continue
            if private_path(name):
                problems.add(('private-path', name))
            for category, pattern in PATTERNS.items():
                if pattern.search(file.read_bytes()):
                    problems.add((category, name))
        for category, name in sorted(problems):
            print(f'{category}: {name}')
    print(f'Checked {len(commits)} commits and {len(objects)} objects; {len(problems)} publication blockers.')
    return 1 if problems else 0

if __name__ == '__main__':
    sys.exit(check())
