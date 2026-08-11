import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CONTROL_BYTES = 1024 * 1024;
const CONTROL_FILES = ['AGENTS.md', 'README.md', 'README.txt'];

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readBounded(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_BYTES) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeGitRemote(value) {
  return value.trim().replace(/\\/gu, '/').replace(/\.git$/iu, '').toLowerCase();
}

function gitRemote(directory) {
  const gitPath = path.join(directory, '.git');
  if (!fs.existsSync(gitPath) || !fs.lstatSync(gitPath).isDirectory()) return null;
  const config = readBounded(path.join(gitPath, 'config'));
  if (!config) return null;
  const origin = config.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/imu);
  return origin ? normalizeGitRemote(origin[1]) : null;
}

function manifestIdentity(directory) {
  const packageText = readBounded(path.join(directory, 'package.json'));
  if (packageText) {
    try {
      const name = JSON.parse(packageText).name;
      if (typeof name === 'string' && name.trim()) {
        return { kind: 'node_package', value: name.trim().normalize('NFC') };
      }
    } catch {
      // Invalid manifests are not identity evidence.
    }
  }
  const pyproject = readBounded(path.join(directory, 'pyproject.toml'));
  if (pyproject) {
    const project = pyproject.match(/^\s*\[project\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/imu);
    if (project) return { kind: 'python_project', value: project[1].trim().normalize('NFC') };
  }
  const cargo = readBounded(path.join(directory, 'Cargo.toml'));
  if (cargo) {
    const project = cargo.match(/^\s*\[package\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/imu);
    if (project) return { kind: 'cargo_package', value: project[1].trim().normalize('NFC') };
  }
  const goMod = readBounded(path.join(directory, 'go.mod'));
  if (goMod) {
    const project = goMod.match(/^\s*module\s+([^\s]+)\s*$/imu);
    if (project) return { kind: 'go_module', value: project[1].trim().normalize('NFC') };
  }
  return null;
}

export function captureProjectIdentity(directory) {
  const absolute = path.resolve(directory);
  const remote = gitRemote(absolute);
  const manifest = manifestIdentity(absolute);
  const control_hashes = [];
  for (const name of CONTROL_FILES) {
    const content = readBounded(path.join(absolute, name));
    if (content != null) control_hashes.push({ path: name, sha256: hash(content) });
  }
  const stable_signals = [];
  if (remote) stable_signals.push('git_remote');
  if (manifest) stable_signals.push(manifest.kind);
  const evidence = {
    schema: 'atlas-project-identity.v1',
    git_remote: remote,
    manifest,
    control_hashes,
  };
  return {
    status: stable_signals.length ? 'captured' : 'insufficient_evidence',
    stable_signals,
    signature_hash: hash(JSON.stringify(evidence)),
    evidence,
  };
}

export function compareProjectIdentity(baseline, candidate) {
  const matched = [];
  const mismatched = [];
  const missing = [];
  if (baseline.git_remote) {
    if (!candidate.git_remote) missing.push('git_remote');
    else if (baseline.git_remote === candidate.git_remote) matched.push('git_remote');
    else mismatched.push('git_remote');
  }
  if (baseline.manifest) {
    const signal = baseline.manifest.kind;
    if (!candidate.manifest || candidate.manifest.kind !== signal) missing.push(signal);
    else if (baseline.manifest.value === candidate.manifest.value) matched.push(signal);
    else mismatched.push(signal);
  }
  const verified = mismatched.length === 0 && (
    matched.includes('git_remote')
    || (matched.some((item) => item !== 'git_remote') && missing.length === 0)
  );
  return {
    status: verified ? 'verified' : 'rejected',
    reason_code: verified
      ? 'identity_match'
      : (mismatched.length ? 'identity_mismatch' : 'identity_evidence_missing'),
    matched_signals: matched,
    mismatched_signals: mismatched,
    missing_signals: missing,
  };
}
