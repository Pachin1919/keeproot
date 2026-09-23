import fs from 'node:fs';
import path from 'node:path';
import { normalizeLanguageLocale } from './i18n.js';
import { withStateLock } from '../state-lock.js';

const MAX_PACK_BYTES = 256 * 1024;
const MAX_PACKS = 32;
const MAX_MESSAGES = 1000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ID_LENGTH = 96;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_LEVEL_KEYS = new Set(['schema', 'id', 'locale', 'name', 'namespace', 'messages']);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeKey(key) {
  return typeof key === 'string'
    && key.length > 0 && key.length <= 160
    && /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(key)
    && !key.split('.').some((part) => BLOCKED_KEYS.has(part));
}

function boundedText(value, field, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\u0000')) throw new TypeError(`${field} must be a non-empty text string of at most ${maximum} characters.`);
  return value;
}

function ownDataEntries(value, field) {
  if (!plainObject(value)) throw new TypeError(`${field} must be a plain JSON object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(`${field} cannot contain accessor properties: ${key}`);
  }
  return Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]);
}

function walkNoLinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new TypeError(`Language pack path cannot traverse a symbolic link or junction: ${current}`);
  }
  return true;
}

function boundedError(file, error) {
  return { file: String(file).slice(0, 160), message: String(error?.message ?? error).slice(0, 360) };
}

function languageDirectory(stateDir) {
  return path.join(path.resolve(stateDir), 'ui', 'languages');
}

function ensureLanguageDirectory(stateDir) {
  const resolvedState = path.resolve(stateDir);
  if (!walkNoLinks(resolvedState)) throw new TypeError('Language pack state directory must already exist without symbolic links or junctions.');
  const uiDirectory = path.join(resolvedState, 'ui');
  const directory = path.join(uiDirectory, 'languages');
  for (const target of [uiDirectory, directory]) {
    if (!walkNoLinks(target)) fs.mkdirSync(target);
    if (!walkNoLinks(target)) throw new TypeError(`Language pack path cannot traverse a symbolic link or junction: ${target}`);
    if (!fs.lstatSync(target).isDirectory()) throw new TypeError('Language pack location is not a directory.');
  }
  return directory;
}

function ensureLockPathSafe(stateDir) {
  const lockDirectory = path.join(stateDir, 'locks');
  if (!walkNoLinks(lockDirectory)) fs.mkdirSync(lockDirectory);
  if (!walkNoLinks(lockDirectory) || !fs.lstatSync(lockDirectory).isDirectory()) throw new TypeError('Language pack lock directory must not traverse a symbolic link or junction.');
  const lockPath = path.join(lockDirectory, 'runtime.lock');
  if (fs.existsSync(lockPath) && fs.lstatSync(lockPath).isSymbolicLink()) throw new TypeError('Language pack lock file must not be a symbolic link or junction.');
}

function readOrdinaryLanguagePack(filePath) {
  if (!walkNoLinks(filePath)) throw new TypeError('Language pack file is missing.');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size > MAX_PACK_BYTES) throw new TypeError(`Language pack must be an ordinary JSON file no larger than ${MAX_PACK_BYTES} bytes.`);
  return inspectLanguagePack(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function assertNoInstallConflict(directory, pack, targetPath) {
  const candidates = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith('.json'));
  if (candidates.length >= MAX_PACKS) throw new TypeError(`At most ${MAX_PACKS} language packs may be installed.`);
  if (fs.existsSync(targetPath)) throw new TypeError(`Language pack id is already installed: ${pack.id}`);
  for (const entry of candidates) {
    const filePath = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new TypeError(`Language pack location contains a non-ordinary file: ${entry.name}`);
    const existing = readOrdinaryLanguagePack(filePath);
    if (existing.id === pack.id) throw new TypeError(`Language pack id is already installed: ${pack.id}`);
    if (existing.locale !== pack.locale || existing.namespace !== pack.namespace) continue;
    const conflict = Object.keys(pack.messages).find((key) => Object.hasOwn(existing.messages, key));
    if (conflict) throw new TypeError(`Language pack conflicts with installed ${pack.locale}/${pack.namespace} key: ${conflict}`);
  }
}

export function inspectLanguagePack(input) {
  const entries = ownDataEntries(input, 'Language pack');
  const keys = entries.map(([key]) => key);
  if (keys.some((key) => !TOP_LEVEL_KEYS.has(key) || BLOCKED_KEYS.has(key))) throw new TypeError('Language pack contains an unknown metadata field.');
  const values = Object.fromEntries(entries);
  if (values.schema !== 'atlas.language-pack.v1') throw new TypeError('Language pack schema is unsupported.');
  if (typeof values.id !== 'string' || values.id.length > MAX_ID_LENGTH || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/u.test(values.id)) throw new TypeError('Language pack id must use author.name form and remain short.');
  const locale = normalizeLanguageLocale(values.locale);
  if (!locale) throw new TypeError('Language pack locale must be a short BCP47-style locale.');
  const name = boundedText(values.name, 'Language pack name', 120);
  if (values.namespace !== 'atlas' && !/^module\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(values.namespace ?? '')) throw new TypeError('Language pack namespace is invalid.');
  const messageEntries = ownDataEntries(values.messages, 'Language pack messages');
  if (!messageEntries.length || messageEntries.length > MAX_MESSAGES) throw new TypeError(`Language pack must contain 1-${MAX_MESSAGES} messages.`);
  const messages = Object.create(null);
  for (const [key, value] of messageEntries) {
    if (!safeKey(key)) throw new TypeError('Language pack message key is invalid.');
    messages[key] = boundedText(value, `Language pack message ${key}`, MAX_MESSAGE_LENGTH);
  }
  const pack = { schema: values.schema, id: values.id, locale, name, namespace: values.namespace, messages: Object.freeze(messages) };
  if (Buffer.byteLength(JSON.stringify(pack), 'utf8') > MAX_PACK_BYTES) throw new TypeError(`Language pack must serialize to no more than ${MAX_PACK_BYTES} bytes.`);
  return Object.freeze(pack);
}

export function installLanguagePack(stateDir, input) {
  const pack = inspectLanguagePack(input);
  const resolvedState = path.resolve(stateDir);
  if (!walkNoLinks(resolvedState)) throw new TypeError('Language pack state directory must already exist without symbolic links or junctions.');
  ensureLockPathSafe(resolvedState);
  return withStateLock(resolvedState, () => {
    const directory = ensureLanguageDirectory(resolvedState);
    const targetPath = path.join(directory, `${pack.id}.json`);
    if (path.dirname(targetPath) !== directory) throw new TypeError('Language pack id resolves outside the language pack directory.');
    assertNoInstallConflict(directory, pack, targetPath);
    const serialized = `${JSON.stringify(pack, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PACK_BYTES) throw new TypeError(`Language pack must serialize to no more than ${MAX_PACK_BYTES} bytes.`);
    fs.writeFileSync(targetPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      const readBack = readOrdinaryLanguagePack(targetPath);
      if (JSON.stringify(readBack) !== JSON.stringify(pack)) throw new TypeError('Language pack read-back did not match the submitted JSON.');
      return { pack: readBack, file: path.basename(targetPath) };
    } catch (error) {
      const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
      if (stat?.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(targetPath);
      throw error;
    }
  });
}

export function loadLanguageCatalog(stateDir) {
  const directory = path.join(path.resolve(stateDir), 'ui', 'languages');
  const packs = [];
  const errors = [];
  try {
    if (!walkNoLinks(directory)) return { packs, errors };
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory()) throw new TypeError('Language pack location is not a directory.');
    const candidates = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith('.json')).sort((left, right) => left.name.localeCompare(right.name));
    if (candidates.length > MAX_PACKS) errors.push(boundedError('languages', `At most ${MAX_PACKS} language packs may be loaded.`));
    const files = candidates.slice(0, MAX_PACKS);
    const claimed = new Map();
    for (const entry of files) {
      try {
        const filePath = path.join(directory, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || !walkNoLinks(filePath)) throw new TypeError('Language pack must be an ordinary non-link JSON file.');
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.size > MAX_PACK_BYTES) throw new TypeError(`Language pack must be an ordinary JSON file no larger than ${MAX_PACK_BYTES} bytes.`);
        const pack = inspectLanguagePack(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        const conflict = Object.keys(pack.messages).find((key) => claimed.has(`${pack.locale}\u0000${pack.namespace}\u0000${key}`));
        if (conflict) throw new TypeError(`Language pack conflicts with an existing ${pack.locale}/${pack.namespace} key: ${conflict}`);
        for (const key of Object.keys(pack.messages)) claimed.set(`${pack.locale}\u0000${pack.namespace}\u0000${key}`, entry.name);
        packs.push(pack);
      } catch (error) { errors.push(boundedError(entry.name, error)); }
    }
  } catch (error) { errors.push(boundedError('languages', error)); }
  return { packs, errors };
}
