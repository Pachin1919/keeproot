import fs from 'node:fs';
import path from 'node:path';

export function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(target, value) {
  atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}
