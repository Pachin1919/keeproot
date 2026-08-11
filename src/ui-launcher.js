import { spawn } from 'node:child_process';

function assertLocalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Atlas UI can open only a local loopback URL.');
  }
  return url.href;
}

export function openLocalUi(value, { platform = process.platform, spawnProcess = spawn } = {}) {
  const url = assertLocalUrl(value);
  let command;
  let args;
  if (platform === 'win32') {
    command = 'explorer.exe';
    args = [url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once?.('error', () => {});
  child.unref();
  return { status: 'requested', url, command };
}
