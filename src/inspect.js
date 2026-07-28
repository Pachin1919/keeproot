import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';

const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_REFERENCE_BYTES = 1024 * 1024;
const MAX_TEXT_FILES = 1000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 200;

const ROLE_HINTS = new Map([
  ['tools', 'tool_source_collection'],
  ['toolchains', 'tool_runtime'],
  ['.tools', 'tool_runtime'],
  ['apps', 'application_collection'],
  ['cache', 'generated_cache'],
  ['.cache', 'generated_cache'],
  ['.pnpm-store', 'package_store'],
  ['node_modules', 'dependency_cache'],
  ['scratch', 'temporary_work'],
  ['tmp', 'temporary_work'],
  ['temp', 'temporary_work'],
  ['build', 'generated_output'],
  ['builds', 'generated_output'],
  ['dist', 'generated_output'],
  ['out', 'generated_output'],
  ['.next', 'generated_output'],
  ['exports', 'output_collection'],
  ['outputs', 'output_collection'],
  ['data', 'data_collection'],
  ['skills', 'agent_skill_collection'],
  ['.agents', 'agent_configuration'],
  ['.codex', 'agent_configuration'],
  ['.git', 'repository_metadata'],
  ['.obsidian', 'library_configuration'],
]);

const SKIP_DIRECTORY_NAMES = new Set([
  '.git', '.pnpm-store', 'node_modules', '.next', 'coverage', 'dist', 'build', 'builds', 'out',
  '.cache', 'cache', 'toolchains', '.tools', '.venv', 'venv', 'vendor', 'bin', 'obj',
  '.dotnet-home', '.nuget-packages', '.appdata', '.localappdata', '.obsidian',
]);

const CONTROL_NAMES = new Set([
  'agents.md', 'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt',
  'cargo.toml', 'go.mod', 'workspace.json', 'tsconfig.json', 'next.config.js', 'next.config.mjs',
  'next.config.ts', '.npmrc',
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.config',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.ps1', '.cmd', '.bat', '.sh', '.py',
  '.cs', '.csproj', '.props', '.targets', '.xml', '.html', '.css', '.scss', '.npmrc',
]);

function roleHint(name) {
  return ROLE_HINTS.get(name.toLowerCase()) ?? 'unresolved';
}

function isControlFile(name) {
  const lower = name.toLowerCase();
  return CONTROL_NAMES.has(lower) || path.extname(lower) === '.csproj'
    || lower === 'readme' || lower.startsWith('readme.');
}

function isReferenceFile(name) {
  const lower = name.toLowerCase();
  return isControlFile(name) || TEXT_EXTENSIONS.has(path.extname(lower)) || lower === '.npmrc';
}

function isPlaceholderVerificationScript(command) {
  return typeof command === 'string'
    && /error:\s*no test specified/iu.test(command)
    && /\bexit\s+1\b/iu.test(command);
}

function portable(root, absolute) {
  return toPortablePath(path.relative(root, absolute)) || '.';
}

function inspectGitMarker(root, markerPath, stat) {
  const repositoryPath = portable(root, path.dirname(markerPath));
  if (stat.isDirectory()) {
    const head = path.join(markerPath, 'HEAD');
    const config = path.join(markerPath, 'config');
    const valid = fs.existsSync(head) && fs.existsSync(config);
    return {
      path: repositoryPath,
      marker: portable(root, markerPath),
      kind: 'directory',
      valid,
      reason: valid ? 'HEAD_and_config_present' : 'missing_HEAD_or_config',
    };
  }
  if (stat.isFile()) {
    const text = fs.readFileSync(markerPath, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/imu.exec(text);
    const target = match ? path.resolve(path.dirname(markerPath), match[1].trim()) : null;
    const valid = Boolean(target && fs.existsSync(target));
    return {
      path: repositoryPath,
      marker: portable(root, markerPath),
      kind: 'file',
      valid,
      reason: valid ? 'gitdir_target_present' : 'invalid_or_missing_gitdir_target',
    };
  }
  return {
    path: repositoryPath,
    marker: portable(root, markerPath),
    kind: 'unsupported',
    valid: false,
    reason: 'unsupported_git_marker',
  };
}

function windowsReferences(text) {
  const results = [];
  const matcher = /[A-Z]:\\[^\r\n"'`<>|]*/gu;
  for (const match of text.matchAll(matcher)) {
    const raw = match[0].replace(/[\])},;]+$/gu, '').trimEnd();
    const normalized = raw.replace(/\\\\/gu, '\\');
    const firstSegment = normalized.slice(3);
    if (/^[nrtvswd][*+?${[(^]/u.test(firstSegment)) continue;
    if (normalized.length >= 3) results.push({ raw, normalized, offset: match.index ?? 0 });
  }
  return results;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function findObsidianAncestor(directory) {
  let cursor = path.dirname(directory);
  while (cursor !== path.dirname(cursor)) {
    const marker = path.join(cursor, '.obsidian');
    if (fs.existsSync(marker)) {
      const stat = fs.lstatSync(marker);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return { directory: cursor, marker };
    }
    cursor = path.dirname(cursor);
  }
  return null;
}

export class WorkspaceInspector {
  inspect({ root: rootInput, maxDepth = 5 } = {}) {
    if (!rootInput) throw new Error('inspect requires --root');
    const root = normalizeRoot(rootInput);
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
      throw new Error('inspect --max-depth must be an integer from 1 to 8');
    }

    const topLevel = [];
    const controlFiles = [];
    const manifests = [];
    const repositories = [];
    const managedLibraries = [];
    const pathReferences = [];
    const reparsePoints = [];
    const excludedTechnical = [];
    const accessErrors = [];
    const workspaceIssues = [];
    const skillGroups = new Map();
    const contentRead = new Map();
    let totalTextBytes = 0;
    let truncated = false;
    let observedEntries = 0;
    const inheritedLibrary = findObsidianAncestor(root);

    const readText = (absolute, relative, limit) => {
      if (contentRead.has(relative)) return contentRead.get(relative).text;
      if (contentRead.size >= MAX_TEXT_FILES || totalTextBytes >= MAX_TEXT_BYTES) {
        truncated = true;
        return null;
      }
      const stat = fs.statSync(absolute);
      const allowed = Math.min(stat.size, limit, MAX_TEXT_BYTES - totalTextBytes);
      const bytes = fs.readFileSync(absolute).subarray(0, allowed);
      const text = bytes.toString('utf8');
      contentRead.set(relative, { bytes: bytes.length, text });
      totalTextBytes += bytes.length;
      if (allowed < stat.size) truncated = true;
      return text;
    };

    const recordSkill = (relative) => {
      const parts = relative.split('/');
      const skillIndex = parts.lastIndexOf('skills');
      if (skillIndex < 0 || skillIndex + 2 >= parts.length) return;
      const collection = parts.slice(0, skillIndex + 1).join('/') || 'skills';
      const packageName = parts[skillIndex + 1];
      if (!skillGroups.has(collection)) skillGroups.set(collection, new Set());
      skillGroups.get(collection).add(packageName);
    };

    const recordSkillCollection = (absolute, relative) => {
      let packages = [];
      try {
        packages = fs.readdirSync(absolute, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(absolute, entry.name, 'SKILL.md')))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        accessErrors.push({ path: relative, code: error.code ?? 'ERROR' });
      }
      if (!packages.length) return;
      if (!skillGroups.has(relative)) skillGroups.set(relative, new Set());
      for (const packageName of packages) skillGroups.get(relative).add(packageName);
    };

    const recordTextFacts = (absolute, relative, name) => {
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_REFERENCE_BYTES || !isReferenceFile(name)) return;
      const text = readText(absolute, relative, stat.size);
      if (text == null) return;

      if (isControlFile(name) && controlFiles.length < MAX_RESULTS) {
        controlFiles.push({
          path: relative,
          kind: name.toLowerCase() === 'package.json' ? 'package_manifest' : 'control_file',
          byte_size: stat.size,
          excerpt: text.slice(0, 1200),
        });
      }

      if (name.toLowerCase() === 'package.json') {
        try {
          const parsed = JSON.parse(text);
          const scriptEntries = Object.entries(parsed.scripts ?? {});
          manifests.push({
            path: relative,
            type: 'node_package',
            name: typeof parsed.name === 'string' ? parsed.name : null,
            private: parsed.private === true,
            scripts: scriptEntries.map(([script]) => script).sort(),
            verification_scripts: scriptEntries
              .filter(([, command]) => !isPlaceholderVerificationScript(command))
              .map(([script]) => script)
              .sort(),
            placeholder_scripts: scriptEntries
              .filter(([, command]) => isPlaceholderVerificationScript(command))
              .map(([script]) => script)
              .sort(),
          });
        } catch (error) {
          manifests.push({ path: relative, type: 'node_package', valid: false, error: error.message });
        }
      }
      if (path.extname(name).toLowerCase() === '.csproj') {
        const framework = /<TargetFramework>([^<]+)<\/TargetFramework>/iu.exec(text)?.[1] ?? null;
        const assemblyName = /<AssemblyName>([^<]+)<\/AssemblyName>/iu.exec(text)?.[1] ?? null;
        manifests.push({
          path: relative,
          type: 'dotnet_project',
          name: assemblyName ?? path.basename(name, path.extname(name)),
          target_framework: framework,
        });
      }

      if (pathReferences.length >= MAX_RESULTS) return;
      for (const found of windowsReferences(text)) {
        if (pathReferences.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
        const reference = path.resolve(found.normalized);
        pathReferences.push({
          file: relative,
          line: lineNumberAt(text, found.offset),
          reference: found.normalized,
          exists: fs.existsSync(reference),
          scope: isPathInside(root, reference) ? 'inside_root' : 'outside_root',
        });
      }
    };

    const isManagedLibrary = (directory) => {
      const marker = path.join(directory, '.obsidian');
      if (!fs.existsSync(marker)) return false;
      const relative = portable(root, directory);
      const pathParts = relative.toLowerCase().split('/');
      if (pathParts.includes('obsidian')) return true;

      const agentsPath = path.join(directory, 'AGENTS.md');
      let agentsText = '';
      if (fs.existsSync(agentsPath) && fs.statSync(agentsPath).isFile()) {
        agentsText = readText(agentsPath, portable(root, agentsPath), MAX_CONTROL_BYTES) ?? '';
      }
      const projectEvidence = /(website|web app|next\.js|source workspace|project|application|网站|工程|项目)/iu.test(agentsText);
      const libraryEvidence = /(knowledge vault|obsidian vault|knowledge library|知识库|笔记库)/iu.test(agentsText);
      if (projectEvidence && !libraryEvidence) {
        workspaceIssues.push({
          kind: 'project_contains_obsidian_config',
          path: portable(root, marker),
          reason: 'project_control_file_outweighs_obsidian_marker',
        });
        return false;
      }
      return true;
    };

    const walk = (directory, depth) => {
      const inherited = depth === 0 ? inheritedLibrary : null;
      const managedLibrary = Boolean(inherited) || isManagedLibrary(directory);
      if (managedLibrary) {
        const relative = portable(root, directory);
        if (!managedLibraries.some((item) => item.path === relative)) {
          managedLibraries.push({
            path: relative,
            marker: portable(root, inherited?.marker ?? path.join(directory, '.obsidian')),
            content_policy: 'root_control_files_only',
            ...(inherited ? {
              inherited: true,
              library_root: inherited.directory,
            } : {}),
          });
        }
      }
      let children;
      try {
        children = fs.readdirSync(directory, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        accessErrors.push({ path: portable(root, directory), code: error.code ?? 'ERROR' });
        return;
      }

      for (const child of children) {
        const absolute = path.join(directory, child.name);
        const relative = portable(root, absolute);
        let stat;
        try {
          stat = fs.lstatSync(absolute);
        } catch (error) {
          accessErrors.push({ path: relative, code: error.code ?? 'ERROR' });
          continue;
        }
        observedEntries += 1;

        if (depth === 0) {
          topLevel.push({
            path: child.name,
            kind: stat.isSymbolicLink() ? 'reparse_point'
              : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
            role_hint: roleHint(child.name),
          });
        }

        if (stat.isSymbolicLink()) {
          let rawTarget = null;
          let targetExists = false;
          try {
            rawTarget = fs.readlinkSync(absolute);
            targetExists = fs.existsSync(path.resolve(path.dirname(absolute), rawTarget));
          } catch {
            // The failed read is represented by the absent target fields.
          }
          reparsePoints.push({ path: relative, raw_target: rawTarget, target_exists: targetExists });
          continue;
        }

        if (child.name.toLowerCase() === '.git') {
          repositories.push(inspectGitMarker(root, absolute, stat));
          continue;
        }

        if (stat.isDirectory()) {
          const lower = child.name.toLowerCase();
          if (lower === 'skills') {
            recordSkillCollection(absolute, relative);
            excludedTechnical.push({ path: relative, role_hint: 'agent_skill_collection' });
            continue;
          }
          if (managedLibrary) {
            if (lower === '.obsidian') {
              excludedTechnical.push({ path: relative, role_hint: 'library_configuration' });
            }
            continue;
          }
          if (SKIP_DIRECTORY_NAMES.has(lower)) {
            excludedTechnical.push({ path: relative, role_hint: roleHint(child.name) });
            continue;
          }
          if (depth + 1 < maxDepth) walk(absolute, depth + 1);
          continue;
        }

        if (!stat.isFile()) continue;
        if (managedLibrary && !isControlFile(child.name)) continue;
        if (child.name.toLowerCase() === 'skill.md') recordSkill(relative);
        recordTextFacts(absolute, relative, child.name);
      }
    };

    walk(root, 0);

    const issues = [
      ...workspaceIssues,
      ...repositories.filter((item) => !item.valid).map((item) => ({
        kind: 'invalid_git_marker', path: item.marker, reason: item.reason,
      })),
      ...manifests.flatMap((manifest) => (manifest.placeholder_scripts ?? []).map((script) => ({
        kind: 'placeholder_verification_script',
        path: manifest.path,
        script,
        reason: 'script_is_default_failure_placeholder',
      }))),
      ...pathReferences.filter((item) => !item.exists).map((item) => ({
        kind: 'missing_absolute_path_target', path: item.file, line: item.line, reference: item.reference,
      })),
    ].slice(0, MAX_RESULTS);

    const verificationCommands = manifests.flatMap((manifest) => (
      manifest.type === 'dotnet_project'
        ? [{ path: manifest.path, command: `dotnet build "${manifest.path}"`, script: 'build' }]
        : (manifest.verification_scripts ?? manifest.scripts ?? [])
          .filter((script) => /^(build|test|check(?::.*)?|validate|typecheck|lint)$/u.test(script))
          .map((script) => ({ path: manifest.path, command: `npm.cmd run ${script}`, script }))
    ));

    return {
      schema: 'atlas-workspace-inspection.v1',
      root,
      max_depth: maxDepth,
      observed_entries: observedEntries,
      top_level: topLevel,
      control_files: controlFiles,
      recommended_agent_reads: controlFiles.map((item) => item.path),
      manifests,
      repositories,
      managed_libraries: managedLibraries,
      skill_collections: [...skillGroups.entries()].map(([collection, packages]) => ({
        path: collection, packages: [...packages].sort(),
      })),
      path_references: pathReferences,
      reparse_points: reparsePoints,
      excluded_technical: excludedTechnical,
      verification_commands: verificationCommands,
      issues,
      access_errors: accessErrors,
      content_files_read: contentRead.size,
      content_bytes_read: totalTextBytes,
      truncated,
      source_changes: [],
    };
  }
}
