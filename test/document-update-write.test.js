import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { documentUpdateWrite } from '../src/document-update-writer.js';
import { locateContentPython } from '../src/python-runtime.js';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
test('transactional Markdown replacement binds file identity and hash; aliases fail closed', () => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-write-'));
  try {
    const target = path.join(root, '笔记.md'); fs.writeFileSync(target, '原文\n');
    const before = documentUpdateWrite({ mode: 'inspect', root, target });
    assert.equal(before.sha256, hash('原文\n'));
    assert.throws(() => documentUpdateWrite({ mode: 'replace', root, target,
      expectedFileId: before.file_id, expectedSha256: hash('错误'), text: '不得写入' }));
    assert.equal(fs.readFileSync(target, 'utf8'), '原文\n');
    const after = documentUpdateWrite({ mode: 'replace', root, target,
      expectedFileId: before.file_id, expectedSha256: before.sha256, text: '完整新文\n' });
    assert.equal(after.file_id, before.file_id);
    assert.equal(after.sha256, hash('完整新文\n'));
    assert.equal(fs.readFileSync(target, 'utf8'), '完整新文\n');
    const link = path.join(root, 'alias.md'); fs.linkSync(target, link);
    assert.throws(() => documentUpdateWrite({ mode: 'inspect', root, target }));
    assert.equal(fs.readFileSync(target, 'utf8'), '完整新文\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const python = locateContentPython();
const helper = path.resolve('python/src/atlas_content/document_update_write.py');
function experiment(code, input) {
  assert.ok(python, 'Document Update tests require a configured content Python runtime.');
  return spawnSync(python, ['-B', '-X', 'utf8', '-c', code], {
    input: JSON.stringify({ helper, ...input }), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
}
const load = `import ctypes as c, importlib.util, json, os, sys, subprocess
q=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('writer',q['helper']); p=importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
`;

test('directory and target ownership cover writer, rename and hardlink attempts through close-to-commit', () => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-boundary-'));
  try {
    const folder = path.join(root, 'governed'); fs.mkdirSync(folder);
    const target = path.join(folder, 'note.md'); fs.writeFileSync(target, 'before');
    const before = documentUpdateWrite({ mode: 'inspect', root, target });
    const code = load + `
original=c.WinDLL
attempts=[]
def competitors():
    code="import os,sys,json; t,f,r=sys.argv[1:]; actions=[lambda:open(t,'wb').write(b'external'),lambda:os.rename(t,t+'.moved'),lambda:os.rename(f,f+'.moved'),lambda:os.link(t,r+'\\\\alias.md')]; results=[]\\nfor action in actions:\\n try: action(); results.append(True)\\n except OSError: results.append(False)\\nprint(json.dumps(results))"
    result=subprocess.run([sys.executable,'-B','-c',code,q['target'],q['folder'],q['root']],capture_output=True,text=True,timeout=5)
    if result.returncode: raise RuntimeError(result.stderr)
    outcomes=json.loads(result.stdout); attempts.append(outcomes)
    if any(outcomes): raise RuntimeError('External mutation passed ownership boundary')
class Proxy:
    def __init__(self,dll): self.dll=dll
    def __getattr__(self,name):
        fn=getattr(self.dll,name)
        if name not in ('WriteFile','CommitTransaction'): return fn
        def wrapped(*args):
            fn.argtypes=wrapped.argtypes; fn.restype=wrapped.restype
            if name=='CommitTransaction': competitors()
            result=fn(*args)
            if name=='WriteFile': competitors()
            return result
        return wrapped
c.WinDLL=lambda *a,**kw:Proxy(original(*a,**kw))
result=p.run(q['request']); result['attempts']=attempts; print(json.dumps(result))
`;
    const done = experiment(code, { root, folder, target, request: { mode: 'replace', root, target,
      expectedFileId: before.file_id, expectedSha256: before.sha256, text: 'after' } });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const result = JSON.parse(done.stdout); assert.deepEqual(result.attempts, [[false, false, false, false], [false, false, false, false]]);
    assert.equal(fs.readFileSync(target, 'utf8'), 'after');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pre-existing writer, unsupported capability and killed partial transaction preserve original bytes', () => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-refusal-'));
  try {
    const target = path.join(root, 'note.md'); fs.writeFileSync(target, 'before');
    const before = documentUpdateWrite({ mode: 'inspect', root, target });
    const request = { mode: 'replace', root, target, expectedFileId: before.file_id, expectedSha256: before.sha256, text: 'after' };
    const preopened = experiment(load + `
k=c.WinDLL('kernel32',use_last_error=True)
fn=k.CreateFileW; fn.argtypes=[c.c_wchar_p,c.c_ulong,c.c_ulong,c.c_void_p,c.c_ulong,c.c_ulong,c.c_void_p]; fn.restype=c.c_void_p
handle=fn(q['target'],0xC0000000,7,None,3,0x00200000,None)
if handle==c.c_void_p(-1).value: raise RuntimeError('fixture writer unavailable')
try:
 try: p.run(q['request']); raise RuntimeError('pre-existing writer was accepted')
 except OSError as error: print(json.dumps({'refused':True,'error':error.errno}))
finally:
 close=k.CloseHandle; close.argtypes=[c.c_void_p]; close(handle)
`, { target, request });
    assert.equal(preopened.status, 0, preopened.stdout + preopened.stderr);
    assert.equal(JSON.parse(preopened.stdout).refused, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    const unsupported = experiment(load + `
sys.platform='unsupported'
try: p.run(q['request']); raise RuntimeError('Unsupported write was accepted')
except ValueError as error: print(json.dumps({'refused':True,'error':str(error)}))
`, { request });
    assert.equal(unsupported.status, 0, unsupported.stderr); assert.equal(JSON.parse(unsupported.stdout).refused, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    const crash = experiment(load + `
original=c.WinDLL
class Proxy:
 def __init__(self,dll): self.dll=dll
 def __getattr__(self,name):
  fn=getattr(self.dll,name)
  if name!='WriteFile': return fn
  def wrapped(handle,buffer,size,count,overlapped):
   fn.argtypes=wrapped.argtypes; fn.restype=wrapped.restype
   fn(handle,buffer,2,count,overlapped); os._exit(77)
  return wrapped
c.WinDLL=lambda *a,**kw:Proxy(original(*a,**kw))
p.run(q['request'])
`, { request });
    assert.equal(crash.status, 77, crash.stderr);
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'linked.md'), 'outside');
    const linked = path.join(root, 'linked'); fs.symlinkSync(outside, linked, 'junction');
    assert.throws(() => documentUpdateWrite({ mode: 'inspect', root, target: path.join(linked, 'linked.md') }));
    assert.throws(() => documentUpdateWrite({ mode: 'replace', root, target: `${target}:stream`,
      expectedFileId: before.file_id, expectedSha256: before.sha256, text: 'bad' }));
    assert.throws(() => documentUpdateWrite({ mode: 'inspect', root: outside, target }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
