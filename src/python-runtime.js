import fs from 'node:fs';
import path from 'node:path';

export function locateContentPython({
  installationRoot,
  configuredPath = process.env.ATLAS_CONTENT_PYTHON
    ?? process.env.ATLAS_DESKTOP_PYTHON
    ?? process.env.ATLAS_PYTHON,
} = {}) {
  const candidates = [
    configuredPath,
    installationRoot && path.join(installationRoot, 'desktop-ui', 'venv', 'Scripts', 'python.exe'),
    installationRoot && path.join(installationRoot, 'desktop-ui', 'venv', 'bin', 'python'),
    // Existing Atlas installations placed the shared content runtime here.
    // Keep reading it during upgrade; this does not restore the removed Analytics commands.
    installationRoot && path.join(installationRoot, 'python', 'venv', 'Scripts', 'python.exe'),
    installationRoot && path.join(installationRoot, 'python', 'venv', 'bin', 'python'),
  ].filter(Boolean).map((item) => path.resolve(item));
  return candidates.find((item) => {
    try {
      return fs.lstatSync(item).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}
