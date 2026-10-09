import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { contentFilePath } from './content-inspection.js';
import { withStateLock } from './state-lock.js';
import { documentUpdateWrite } from './document-update-writer.js';
import { assertRecoveryWritable } from './storage/recovery-write-guard.js';
import { BoardService } from './board-service.js';
import { createSavedWorkService } from './ui/services/saved-work-service.js';
import { createProjectMoveService } from './project-move-service.js';
import { createProjectMembershipService } from './project-membership-service.js';
import { rewriteMarkdownLinks, LINK_REPAIR_ALGORITHM } from './markdown-link-rewrite.js';

const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 2 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const DECODER = new TextDecoder('utf-8', { fatal: true });

function conflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function requireText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw conflict(`${label} is required.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_BLOCK_BYTES) throw conflict(`${label} must be at most ${MAX_BLOCK_BYTES} UTF-8 bytes.`);
  return value;
}

function assertNoLinkPath(input) {
  const absolute = path.resolve(input);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') throw conflict(`Document Update path is unavailable: ${cursor}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw conflict('Document Update paths cannot pass through a symbolic link or junction.');
  }
  return absolute;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
}

function insertBlock(text, oldText, newText) {
  if (oldText) {
    const count = occurrences(text, oldText);
    if (count !== 1) throw conflict(count === 0
      ? 'The old text block is not present exactly once.'
      : 'The old text block is ambiguous because it appears more than once.');
    return text.replace(oldText, newText);
  }
  if (!newText) throw conflict('Append suggestions require non-empty text.');
  const separator = !text || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${newText}`;
}

function validateCaller(caller, requestKey) {
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)
    || typeof caller.tool !== 'string' || !caller.tool.trim()
    || typeof caller.client_run_id !== 'string' || !caller.client_run_id.trim()
    || typeof requestKey !== 'string' || !requestKey.trim()) {
    throw conflict('Document Update requires a caller tool, client_run_id, and request key.');
  }
  return { tool: caller.tool.trim(), client_run_id: caller.client_run_id.trim() };
}

function requestKeyId(projectId, caller, requestKey) {
  return sha256(`${projectId}\0${caller.tool}\0${caller.client_run_id}\0${requestKey}`).slice(0, 32);
}

function requestDigest(value) { return sha256(JSON.stringify(value)); }

function manualNewlines(text) {
  const rest = text.replaceAll('\r\n', '');
  if (rest.includes('\r') || (text.includes('\r\n') && rest.includes('\n'))) throw conflict('Manual editing refuses mixed newline endings. Normalize them in an external editor first.');
  return text.includes('\r\n') ? 'crlf' : 'lf';
}

function manualBody(text, policy, hasBom) {
  if (typeof text !== 'string' || text.startsWith('\uFEFF') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw conflict('Manual editor text must be BOM-free valid UTF-8 text.');
  manualNewlines(text);
  const normalized = text.replaceAll('\r\n', '\n');
  const raw = (hasBom ? '\uFEFF' : '') + (policy === 'crlf' ? normalized.replaceAll('\n', '\r\n') : normalized);
  if (Buffer.byteLength(raw, 'utf8') > MAX_MARKDOWN_BYTES) throw conflict('Manual output exceeds the text file byte limit.');
  return raw;
}

export class DocumentUpdateService {
  constructor({ stateDir, registry, resourceControl, saveService, writer = documentUpdateWrite, operationHook = () => {} }) {
    if (!stateDir || !registry || !resourceControl || !saveService) {
      throw new Error('Document Update requires stateDir, Registry, ResourceControl, and SaveService.');
    }
    this.stateDir = path.resolve(stateDir);
    this.registry = registry;
    this.resourceControl = resourceControl;
    this.saveService = saveService;
    this.writer = writer;
    this.operationHook = operationHook;
    this.savedWork = createSavedWorkService({ stateDir: this.stateDir, saveService });
    this.boards = new BoardService({ stateDir: this.stateDir, registry, resourceControl, saveService });
  }

  #storeDirectory() {
    assertNoLinkPath(this.stateDir);
    const directory = path.join(this.stateDir, 'document-updates');
    try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertNoLinkPath(directory);
    if (!fs.lstatSync(directory).isDirectory()) throw conflict('Document Update state path is not a directory.');
    return directory;
  }

  #stateFile(updateId) {
    if (typeof updateId !== 'string' || !/^UPD-[a-f0-9]{32}$/u.test(updateId)) throw conflict('Document Update ID is invalid.');
    return path.join(this.#storeDirectory(), `${updateId}.json`);
  }

  #readRecord(updateId) {
    const file = this.#stateFile(updateId);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') throw conflict('Document Update is unavailable.');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw conflict('Document Update state is not a bounded regular file.');
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw conflict('Document Update state is invalid.'); }
    if (value.schema !== 'atlas.document-update.v1' || value.update_id !== updateId) throw conflict('Document Update state identity is invalid.');
    return value;
  }

  #writeRecord(updateId, value, { create = false } = {}) {
    const directory = this.#storeDirectory();
    const file = path.join(directory, `${updateId}.json`);
    const temporary = path.join(directory, `.${updateId}.${crypto.randomUUID()}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_STATE_BYTES) throw conflict('Document Update state exceeds its storage limit.');
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      assertNoLinkPath(directory);
      if (create) {
        fs.linkSync(temporary, file);
      } else {
        const existing = fs.lstatSync(file);
        if (!existing.isFile() || existing.isSymbolicLink()) throw conflict('Document Update state changed outside Atlas.');
        fs.renameSync(temporary, file);
      }
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  #resource(projectId, resourceId) {
    const projectDetail = this.registry.show(projectId);
    if (!projectDetail.project || projectDetail.project.status !== 'active' || !projectDetail.location?.root_path) {
      throw conflict('Document Update requires an active Project with an attached local Root.');
    }
    let fact;
    try { fact = this.resourceControl.projectResource(projectId, resourceId); } catch {
      throw conflict('The Resource is not registered in this Project.');
    }
    const active = (fact.locations ?? []).filter((item) => item.project_id === projectId && item.status === 'active');
    if (active.length !== 1) throw conflict('Document Update requires exactly one active Resource location in this Project.');
    const location = active[0];
    const projectRoot = assertNoLinkPath(path.resolve(projectDetail.location.root_path, projectDetail.location.relative_path));
    const filePath = assertNoLinkPath(location.path);
    if (!inside(projectRoot, filePath)) throw conflict('The Resource path is outside this Project.');
    if (!['.md', '.txt'].includes(path.extname(filePath).toLowerCase())) throw conflict('Document Update supports only UTF-8 MD or TXT Resources.');
    let checked;
    try { checked = contentFilePath(filePath); } catch { throw conflict('The text Resource is unavailable or linked.'); }
    const stat = fs.lstatSync(checked);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MARKDOWN_BYTES) {
      throw conflict(`text Resource must be a regular file no larger than ${MAX_MARKDOWN_BYTES} bytes.`);
    }
    let bytes;const fd=fs.openSync(checked,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      const before=fs.fstatSync(fd);const buffer=Buffer.alloc(MAX_MARKDOWN_BYTES+1);let count=0;
      while(count<buffer.length){const n=fs.readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}
      const after=fs.fstatSync(fd);assertNoLinkPath(checked);const current=fs.lstatSync(checked);
      if(count>MAX_MARKDOWN_BYTES||count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||before.dev!==current.dev||before.ino!==current.ino||after.mtimeMs!==current.mtimeMs||after.size!==current.size)throw conflict('Text Resource changed during bounded read; inspect it again.');
      bytes=buffer.subarray(0,count);
    } finally {fs.closeSync(fd);}
    let text;
    try { text = DECODER.decode(bytes); } catch { throw conflict('text Resource is not valid UTF-8.'); }
    return {
      project_id: projectId, resource_id: resourceId, path: checked,
      relative_path: path.relative(projectRoot, checked).replaceAll('\\', '/'),
      sha256: sha256(bytes), bytes: bytes.length, text,
      location_id: location.id, root_path: projectRoot, has_bom: bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])),
    };
  }

  #source(projectId, saveId) {
    let save;
    try { save = this.saveService.show(saveId); } catch { throw conflict('Source Save is unavailable.'); }
    if (save.project?.id !== projectId || save.status !== 'executed' || save.current_output !== 'verified' || save.source?.kind !== 'capture_source'
      || !save.source.source_id || !save.source.version_id || !save.resource_id) {
      throw conflict('Source must be an executed Capture Source Save in this Project.');
    }
    try {
      const fact = this.resourceControl.projectResource(projectId, save.resource_id);
      if (!(fact.locations ?? []).some((item) => item.project_id === projectId && item.status === 'active')) throw new Error('inactive');
    } catch { throw conflict('The Source Save Resource is no longer active in this Project.'); }
    return {
      save_id: save.save_id, resource_id: save.resource_id,
      source_id: save.source.source_id, version_id: save.source.version_id,
      current_output: save.current_output ?? null,
    };
  }

  #basis(spec) {
    if(!['project_move','project_membership'].includes(spec?.kind))throw conflict('Unsupported Document Update source kind.');
    const factory=spec.kind==='project_move'?createProjectMoveService:createProjectMembershipService;
    const service=factory({stateDir:this.stateDir,registry:this.registry,resourceControl:this.resourceControl});
    return service.referenceBasis(spec.operationId??spec.operation_id,{sourceProjectId:spec.sourceProjectId??spec.source_project_id,expectedRevision:spec.expectedRevision??spec.revision,expectedDigest:spec.expectedDigest??spec.digest});
  }

  #linkTarget(targetPath,basis) {
    const db=this.registry.ledger.db;const checked=assertNoLinkPath(path.resolve(targetPath));
    if(!inside(basis.root_path,checked)||path.extname(checked).toLowerCase()!=='.md')throw conflict('Link target must be Markdown inside the registered Root.');
    const locations=db.prepare(`SELECT id,resource_id,project_id,path FROM resource_locations WHERE status='active' AND ${process.platform==='win32'?'lower(path)=lower(?)':'path=?'}`).all(checked);
    if(locations.length!==1)throw conflict('Link target has no unique registered active location.');
    const l=locations[0];const all=db.prepare("SELECT id FROM resource_locations WHERE status='active' AND resource_id=?").all(l.resource_id);
    const project=this.registry.show(l.project_id);
    if(all.length!==1||project.project.status!=='active'||project.location?.root_id!==basis.root_id||path.resolve(project.location.root_path)!==basis.root_path||!inside(path.resolve(project.location.root_path,project.location.relative_path),checked))throw conflict('Link target Project or Resource boundary changed.');
    const stat=fs.lstatSync(checked,{bigint:true});if(!stat.isFile()||stat.nlink!==1n)throw conflict('Link target must be a regular file without hard links.');
    return {resource_id:l.resource_id,location_id:l.id,project_id:l.project_id,path:path.resolve(l.path),file_identity:{dev:String(stat.dev),ino:String(stat.ino)}};
  }

  #typedSource(projectId,source,{allowManual=false}={}) {
    if(source.kind==='manual_edit') {
      if(!allowManual || source.origin!=='manual_editor' || Object.keys(source).length!==2 || Object.keys(source).some(key=>!['kind','origin'].includes(key)))throw conflict('Manual source requires an exact manual-editor source paired with a whole-text preview.');
      return source;
    }
    if(!source.kind)return this.#source(projectId,source.save_id);
    const basis=this.#basis(source);const project=this.registry.show(projectId);
    if(project.project.status!=='active'||project.location?.root_id!==basis.root_id||path.resolve(project.location.root_path)!==basis.root_path)throw conflict('Selected document must belong to an active Project in the movement Root.');
    if(requestDigest(basis.mappings)!==source.mapping_digest)throw conflict('Movement reference mapping changed.');
    for(const target of source.targets??[]){const current=this.#linkTarget(target.path,basis);if(requestDigest(current)!==requestDigest(target))throw conflict('Registered link target location or file identity changed.');}
    return source;
  }

  #checkSource(projectId,source,options={}) {
    const current=this.#typedSource(projectId,source,options);
    if(requestDigest(current)!==requestDigest(source))throw conflict('Document Update source changed.');
  }

  #prepareLinks({projectId,resourceId,expectedSha256,source:spec,patch,oldText,newText,sourceSaveId,requestKey,caller}) {
    const normalizedCaller=validateCaller(caller,requestKey);
    if(sourceSaveId!==undefined||oldText!==undefined||newText!==undefined||patch?.kind!=='link_repair'||patch.wikiBase!=='registered_root'||!Array.isArray(patch.syntax)||!patch.syntax.length||patch.syntax.some(k=>!['relative_markdown','wikilink'].includes(k))||Object.keys(patch).some(k=>!['kind','syntax','wikiBase'].includes(k)))throw conflict('Link repair requires a movement source and structured syntax; free text replacement is unsupported.');
    const base=this.#resource(projectId,resourceId);
    if(base.sha256!==expectedSha256||!/^[a-f0-9]{64}$/u.test(expectedSha256??''))throw conflict('The selected Markdown changed; inspect it again.');
    if(path.extname(base.path).toLowerCase()!=='.md'||base.has_bom)throw conflict('Link repair supports UTF-8 Markdown without BOM only.');
    if(this.registry.ledger.db.prepare("SELECT count(*) AS n FROM resource_locations WHERE resource_id=? AND status='active'").get(resourceId).n!==1||fs.lstatSync(base.path).nlink!==1)throw conflict('Selected Markdown requires one active location and no hard links.');
    const basis=this.#basis(spec);const project=this.registry.show(projectId);
    if(project.location.root_id!==basis.root_id||path.resolve(project.location.root_path)!==basis.root_path)throw conflict('Selected Markdown must be in the movement registered Root.');
    const oldPath=basis.mappings.find(m=>m.to_path===base.path)?.from_path??base.path;
    const repair=rewriteMarkdownLinks({text:base.text,rootPath:basis.root_path,documentPath:base.path,oldDocumentPath:oldPath,mappings:basis.mappings,syntax:patch.syntax,resolveTarget:p=>this.#linkTarget(p,basis)});
    const source={kind:basis.kind,operation_id:basis.operation_id,source_project_id:spec.sourceProjectId,revision:basis.revision,digest:basis.digest,root_id:basis.root_id,root_path:basis.root_path,mapping_digest:requestDigest(basis.mappings),affected_project_ids:basis.affected_project_ids,algorithm:LINK_REPAIR_ALGORITHM,targets:repair.targets};
    const payloadDigest=requestDigest({project_id:projectId,resource_id:resourceId,expected_sha256:expectedSha256,source_binding:source,patch,algorithm:LINK_REPAIR_ALGORITHM});
    const updateId=`UPD-${requestKeyId(projectId,normalizedCaller,requestKey.trim())}`;
    return withStateLock(this.stateDir,()=>{
      const directory=this.#storeDirectory();const file=path.join(directory,`${updateId}.json`);
      if(fs.existsSync(file)){const r=this.#readRecord(updateId);if(r.request_digest!==payloadDigest)throw conflict('Document Update request key already identifies different facts.');return this.show(updateId,{projectId});}
      this.#checkSource(projectId,source);const current=this.#resource(projectId,resourceId);
      if(current.sha256!==base.sha256||current.location_id!==base.location_id||current.path!==base.path)throw conflict('Selected Markdown changed while preparing link repair.');
      if(!repair.edits.length)return {status:'no_change',project_id:projectId,resource_id:resourceId,skipped:repair.skipped};
      const bytes=Buffer.from(repair.text,'utf8');if(bytes.length>MAX_MARKDOWN_BYTES)throw conflict('Link repair output exceeds the Markdown size limit.');
      const at=new Date().toISOString();const record={schema:'atlas.document-update.v1',update_id:updateId,project_id:projectId,resource_id:resourceId,revision:1,status:'preview_ready',created_at:at,updated_at:at,caller:normalizedCaller,request_key:requestKey.trim(),request_digest:payloadDigest,
        resource:{relative_path:base.relative_path,location_id:base.location_id,path:base.path,root_path:base.root_path},source,baseline:{sha256:base.sha256,bytes:base.bytes,text:base.text},patch:{kind:'link_repair',edits:repair.edits,skipped:repair.skipped},proposed:{sha256:sha256(bytes),bytes:bytes.length,text:repair.text},prepared_current:{sha256:base.sha256,bytes:base.bytes},decision:null,decision_requests:{}};
      this.#writeRecord(updateId,record,{create:true});return this.#present(record,current);
    });
  }

  inspect({ projectId, resourceId }) {
    const current = this.#resource(projectId, resourceId);
    return {
      project_id: projectId, resource_id: resourceId,
      relative_path: current.relative_path,
      baseline: { sha256: current.sha256, bytes: current.bytes, text: current.text },
      limits: { text_bytes: MAX_MARKDOWN_BYTES, markdown_bytes: MAX_MARKDOWN_BYTES, block_utf8_bytes: MAX_BLOCK_BYTES },
      references: this.#references(projectId, resourceId),
    };
  }

  #manualGuards(projectId, resourceId, ownUpdateId = null) {
    assertRecoveryWritable(this.registry.ledger.db, { projectId, resourceId });
    const directory = this.#storeDirectory();
    const files = fs.readdirSync(directory).filter(name => !name.endsWith('.tmp'));
    if (files.length > 10000) throw conflict('Document Update pending inspection exceeds its record limit.');
    let total = 0;
    for (const file of files) {
      if (!/^UPD-[a-f0-9]{32}\.json$/u.test(file)) throw conflict('Document Update journal contains an unknown record.');
      total += fs.lstatSync(path.join(directory,file)).size;
      if (total > 32 * 1024 * 1024) throw conflict('Document Update pending inspection exceeds its byte limit.');
      const row = this.#readRecord(file.slice(0,-5));
      if (row.update_id !== ownUpdateId && (row.project_id === projectId || row.resource_id === resourceId || row.source?.affected_project_ids?.includes(projectId)) && (row.pending || row.status === 'pending_recovery')) throw conflict('Recover the pending text update before manual editing.');
    }
  }

  #manualResource(projectId, resourceId, expectedFileId = null) {
    const current = this.#resource(projectId, resourceId);
    const db = this.registry.ledger.db;
    const locations = db.prepare("SELECT id,path FROM resource_locations WHERE resource_id=? AND status='active'").all(resourceId);
    const aliases = db.prepare(`SELECT id FROM resource_locations WHERE status='active' AND ${process.platform === 'win32' ? 'lower(path)=lower(?)' : 'path=?'}`).all(current.path);
    if (locations.length !== 1 || aliases.length !== 1 || aliases[0].id !== current.location_id || fs.lstatSync(current.path).nlink !== 1) throw conflict('Manual editing requires one global active Resource location without aliases or hard links.');
    const newline = manualNewlines(current.text);
    const inspected = this.writer({ mode: 'inspect', root: current.root_path, target: current.path, expectedSha256: current.sha256, ...(expectedFileId ? { expectedFileId } : {}) });
    if (inspected.sha256 !== current.sha256 || inspected.bytes !== current.bytes || inspected.text !== (current.has_bom ? '\uFEFF' : '') + current.text || !inspected.file_id) throw conflict('Manual text identity or bytes changed during inspection.');
    const rootStat=fs.lstatSync(current.root_path,{bigint:true});
    return { ...current, file_id: inspected.file_id, newline_policy: newline, raw_text: inspected.text,
      root_id:this.registry.show(projectId).location.root_id, root_identity:`${rootStat.dev}:${rootStat.ino}` };
  }

  #manualCapacity(record) {
    const check = value => { if (Buffer.byteLength(`${JSON.stringify(value,null,2)}\n`,'utf8') > MAX_STATE_BYTES) throw conflict('Manual serialized preview, decision or recovery state exceeds its storage limit.'); };
    check(record);
    const projected = structuredClone(record);
    projected.decision ??= { kind: 'accept-suggestion', decided_at: new Date().toISOString(), based_on_revision: record.revision, current_sha256: record.baseline.sha256, candidate: record.proposed };
    projected.manual_confirmation ??= { key: '0'.repeat(32), digest: '0'.repeat(64), preview_revision: record.revision };
    check(projected);
    const pending = { kind: 'execute', operation_id: `RACT-${crypto.randomUUID()}`, key: '0'.repeat(32), digest: '0'.repeat(64), target: record.resource.path, root: record.resource.root_path, file_id: record.resource.file_id, before: record.baseline, after: record.proposed, caller: record.caller, created_at: new Date().toISOString() };
    projected.operation_requests ??= {}; projected.operation_requests[pending.key] = { digest: pending.digest, operation_id: pending.operation_id, status: 'pending' };
    projected.pending = pending; projected.status = 'pending_recovery'; projected.revision += 2; check(projected);
    projected.execution = { operation_id: pending.operation_id, file_id: pending.file_id, before: pending.before, after: pending.after };
    projected.pending = null; projected.status = 'applied'; projected.revision++;
    projected.operation_requests[pending.key] = { ...projected.operation_requests[pending.key], status: 'applied', receipt: { ...pending, before: undefined, after: undefined, before_sha256: pending.before.sha256, after_sha256: pending.after.sha256, before_bytes: pending.before.bytes, after_bytes: pending.after.bytes } }; check(projected);
    // Retain enough room for exact-byte Undo's pending before/after journal too.
    projected.pending = { ...pending, kind: 'undo', before: pending.after, after: pending.before }; check(projected);
  }

  inspectManual({ projectId, resourceId }) {
    this.#manualGuards(projectId, resourceId);
    const current = this.#manualResource(projectId, resourceId);
    return { project_id: projectId, resource_id: resourceId, relative_path: current.relative_path,
      baseline: { sha256: current.sha256, bytes: current.bytes, text: current.text },
      limits: { text_bytes: MAX_MARKDOWN_BYTES, markdown_bytes: MAX_MARKDOWN_BYTES, block_utf8_bytes: MAX_BLOCK_BYTES },
      editing: { supported: true, max_utf8_bytes: MAX_MARKDOWN_BYTES, has_bom: current.has_bom, newline_policy: current.newline_policy },
      identity: { location_id: current.location_id, file_id: current.file_id }, references: this.#references(projectId,resourceId) };
  }

  prepareManual(input) {
    if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['projectId','resourceId','expectedSha256','expectedFileId','text','requestKey','caller'].includes(key)))throw conflict('Manual preview accepts only inspected identity, full text and caller fields; source and patch are assigned by Atlas.');
    const { projectId,resourceId,expectedSha256,expectedFileId,text,requestKey,caller }=input;
    const normalizedCaller = validateCaller(caller,requestKey);
    if(normalizedCaller.tool.length>128 || normalizedCaller.client_run_id.length>128 || requestKey.length>256)throw conflict('Manual caller and request key exceed their metadata limits.');
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '') || typeof expectedFileId !== 'string' || !expectedFileId || expectedFileId.length > 128 || typeof text !== 'string') throw conflict('Manual preview requires the inspected Hash, file identity and full text.');
    if(Buffer.byteLength(text,'utf8')>MAX_MARKDOWN_BYTES)throw conflict(`Manual draft exceeds the ${MAX_MARKDOWN_BYTES} UTF-8 byte limit.`);
    const payload = requestDigest({ projectId,resourceId,expectedSha256,expectedFileId,text });
    const updateId = `UPD-${requestKeyId(projectId,normalizedCaller,requestKey.trim())}`;
    this.#storeDirectory();
    return withStateLock(this.stateDir, () => {
      if (fs.existsSync(this.#stateFile(updateId))) {
        const existing = this.#readRecord(updateId);
        if (existing.source?.kind !== 'manual_edit' || existing.request_digest !== payload) throw conflict('Manual preview request key was used for different facts.');
        return this.show(updateId,{projectId});
      }
      this.#manualGuards(projectId,resourceId);
      const current = this.#manualResource(projectId,resourceId,expectedFileId);
      if (current.sha256 !== expectedSha256) throw conflict('Manual text changed after inspection; reload and compare the draft.');
      const raw = manualBody(text,current.newline_policy,current.has_bom);
      if (raw === current.raw_text) return { status:'no_change',project_id:projectId,resource_id:resourceId,sha256:current.sha256,current:{sha256:current.sha256} };
      const at = new Date().toISOString();
      const record = { schema:'atlas.document-update.v1', update_id:updateId, project_id:projectId, resource_id:resourceId, revision:1, status:'preview_ready', created_at:at, updated_at:at, caller:normalizedCaller, request_key:requestKey.trim(), request_digest:payload,
        resource:{relative_path:current.relative_path,location_id:current.location_id,path:current.path,root_path:current.root_path,file_id:current.file_id,root_id:current.root_id,root_identity:current.root_identity},
        source:{kind:'manual_edit',origin:'manual_editor'}, editing:{has_bom:current.has_bom,newline_policy:current.newline_policy},
        baseline:{sha256:current.sha256,bytes:current.bytes,text:current.raw_text}, patch:{kind:'whole_text'},
        proposed:{sha256:sha256(Buffer.from(raw,'utf8')),bytes:Buffer.byteLength(raw,'utf8'),text:raw}, prepared_current:{sha256:current.sha256,bytes:current.bytes}, decision:null,decision_requests:{} };
      this.#manualCapacity(record); this.#writeRecord(updateId,record,{create:true}); return this.#present(record,current);
    });
  }

  confirmManual(updateId,options) {
    if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(key=>!['projectId','expectedRevision','expectedCurrentSha256','expectedProposedSha256','requestKey','caller'].includes(key)))throw conflict('Manual confirmation accepts only displayed revision, Hash and caller fields.');
    const { projectId,expectedRevision,expectedCurrentSha256,expectedProposedSha256,requestKey,caller }=options;
    const normalizedCaller = validateCaller(caller,requestKey);
    if(normalizedCaller.tool.length>128 || normalizedCaller.client_run_id.length>128 || requestKey.length>256)throw conflict('Manual caller and request key exceed their metadata limits.');
    const key = requestKeyId(projectId,normalizedCaller,requestKey.trim());
    const digest = requestDigest({ updateId,projectId,expectedRevision,expectedCurrentSha256,expectedProposedSha256 });
    return withStateLock(this.stateDir,()=>{
      const record = this.#readRecord(updateId);
      if(record.project_id!==projectId || record.source?.kind!=='manual_edit' || record.patch.kind!=='whole_text')throw conflict('Manual confirmation requires its Project manual preview.');
      this.#checkSource(projectId,record.source,{allowManual:true});
      if(record.manual_confirmation){
        if(record.manual_confirmation.key!==key || record.manual_confirmation.digest!==digest)throw conflict('Manual confirmation facts or request key changed; reload the preview.');
        if(record.pending)return this.show(updateId,{projectId});
        if(record.status==='applied'||record.status==='undone')return this.show(updateId,{projectId});
        throw conflict('Manual confirmation was not applied. Create a new preview; no write is retried.');
      }
      if(record.pending || record.revision!==expectedRevision || record.status!=='preview_ready' || record.baseline.sha256!==expectedCurrentSha256 || record.proposed.sha256!==expectedProposedSha256)throw conflict('Manual preview revision or displayed Hash changed; reload before Save.');
      this.#manualGuards(projectId,record.resource_id,updateId);
      const current=this.#manualResource(projectId,record.resource_id,record.resource.file_id);
      if(current.path!==record.resource.path || current.root_path!==record.resource.root_path || current.location_id!==record.resource.location_id || current.root_id!==record.resource.root_id || current.root_identity!==record.resource.root_identity || current.sha256!==expectedCurrentSha256)throw conflict('Manual Resource location, identity or current text changed.');
      record.manual_confirmation={key,digest,preview_revision:expectedRevision};
      record.decision={kind:'accept-suggestion',decided_at:new Date().toISOString(),based_on_revision:expectedRevision,current_sha256:current.sha256,candidate:record.proposed};
      record.revision++; record.updated_at=new Date().toISOString(); this.#manualCapacity(record); this.#writeRecord(updateId,record);
      return this.#mutateLocked('execute',updateId,{projectId,expectedRevision:record.revision,expectedCurrentSha256,expectedFileId:record.resource.file_id,requestKey,caller:normalizedCaller,manualConfirmed:true});
    });
  }

  prepare(input) {
    if(input.source?.kind==='manual_edit' || input.patch?.kind==='whole_text')throw conflict('Manual whole-text previews require prepareManual.');
    if(input.source)return this.#prepareLinks(input);
    if(input.patch?.kind==='link_repair')throw conflict('Link repair requires a movement source.');
    const { projectId, resourceId, expectedSha256, oldText, newText, sourceSaveId, requestKey, caller }=input;
    const normalizedCaller = validateCaller(caller, requestKey);
    const oldBlock = requireText(oldText, 'Old text block', { allowEmpty: true });
    const newBlock = requireText(newText, 'Suggested text block', { allowEmpty: oldBlock === '' });
    const base = this.#resource(projectId, resourceId);
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '') || base.sha256 !== expectedSha256) {
      throw conflict('The text Resource changed after inspection; inspect it again before preparing.');
    }
    if (oldBlock && occurrences(base.text, oldBlock) !== 1) {
      throw conflict('The old text block must appear exactly once in the inspected baseline.');
    }
    const proposedText = insertBlock(base.text, oldBlock, newBlock);
    const proposedBytes = Buffer.from(proposedText, 'utf8');
    if (proposedBytes.length > MAX_MARKDOWN_BYTES) throw conflict('The proposed text preview exceeds the file size limit.');
    const source = this.#source(projectId, sourceSaveId);
    const keyDigest = requestKeyId(projectId, normalizedCaller, requestKey.trim());
    const updateId = `UPD-${keyDigest}`;
    const request = { project_id: projectId, resource_id: resourceId, expected_sha256: expectedSha256,
      old_text: oldBlock, new_text: newBlock, source_save_id: source.save_id };
    const payloadDigest = requestDigest(request);
    this.#storeDirectory();
    return withStateLock(this.stateDir, () => {
      const file = this.#stateFile(updateId);
      if (fs.existsSync(file)) {
        const existing = this.#readRecord(updateId);
        if (existing.request_digest !== payloadDigest || existing.caller?.tool !== normalizedCaller.tool
          || existing.caller?.client_run_id !== normalizedCaller.client_run_id || existing.request_key !== requestKey.trim()) {
          throw conflict('This Document Update request key was already used for different facts.');
        }
        return this.show(updateId, { projectId });
      }
      const current = this.#resource(projectId, resourceId);
      const currentSource = this.#source(projectId, sourceSaveId);
      if (current.sha256 !== expectedSha256 || current.location_id !== base.location_id
        || currentSource.version_id !== source.version_id || currentSource.resource_id !== source.resource_id) {
        throw conflict('The Resource or source Save changed while the preview was being prepared.');
      }
      const at = new Date().toISOString();
      const record = {
        schema: 'atlas.document-update.v1', update_id: updateId, project_id: projectId, resource_id: resourceId,
        revision: 1, status: 'preview_ready', created_at: at, updated_at: at,
        caller: normalizedCaller, request_key: requestKey.trim(), request_digest: payloadDigest,
        resource: { relative_path: base.relative_path, location_id: base.location_id, path: base.path, root_path: base.root_path },
        source,
        baseline: { sha256: base.sha256, bytes: base.bytes, text: base.text },
        patch: { kind: oldBlock ? 'replace' : 'append', old_text: oldBlock, suggested_text: newBlock },
        proposed: { sha256: sha256(proposedBytes), bytes: proposedBytes.length, text: proposedText },
        prepared_current: { sha256: base.sha256, bytes: base.bytes },
        decision: null, decision_requests: {},
      };
      this.#writeRecord(updateId, record, { create: true });
      return this.#present(record, current);
    });
  }

  #present(record, current) {
    const expectedHash = record.status === 'applied' ? record.execution?.after.sha256
      : record.status === 'undone' ? record.execution?.before.sha256 : record.baseline.sha256;
    const conflictInfo = !current
      ? { kind: 'resource_unavailable', reason: 'The current text Resource is unavailable.' }
      : current.sha256 === expectedHash ? null
        : ['append','link_repair','whole_text'].includes(record.patch.kind) ? { kind: 'independent_change', reason: 'The text changed after the preview; review the current text before deciding.' }
          : occurrences(current.text, record.patch.old_text) === 1
            ? { kind: 'independent_change', reason: 'The current text changed outside the selected block; review all three versions.' }
            : occurrences(current.text, record.patch.old_text) === 0
              ? { kind: 'block_changed_or_missing', reason: 'The selected old block changed or is missing in the current text.' }
              : { kind: 'block_ambiguous', reason: 'The selected old block is no longer unique in the current text.' };
    let sourceInfo={};if(record.source.kind){try{this.#checkSource(record.project_id,record.source,{allowManual:record.patch.kind==='whole_text'});sourceInfo={source_status:'current',source_conflict:null};}catch(error){sourceInfo={source_status:/unavailable|ENOENT|no such|not found/iu.test(error.message)?'unavailable':'changed',source_conflict:{reason:String(error.message).slice(0,500)}};}}
    return {
      update_id: record.update_id, project_id: record.project_id, resource_id: record.resource_id,
      revision: record.revision, status: record.pending ? 'pending_recovery' : conflictInfo ? 'conflict' : record.status,
      resource: record.resource, source: record.source, ...sourceInfo,
      baseline: this.#editorFact(record,record.baseline), proposed: this.#editorFact(record,record.proposed),
      current: current ? { sha256: current.sha256, bytes: current.bytes, text: current.text } : null,
      conflict: conflictInfo, decision: record.decision,
      candidate: record.decision?.candidate ? this.#editorFact(record,record.decision.candidate) : null,
      pending: record.pending ? { operation_id: record.pending.operation_id, kind: record.pending.kind } : null,
      execution: record.execution ?? null, recovery: record.recovery ?? null,
      change: this.#change(record, current),
      references: this.#references(record.project_id, record.resource_id),
      created_at: record.created_at, updated_at: record.updated_at,
    };
  }

  #editorFact(record,fact) { return record.patch.kind==='whole_text' && record.editing?.has_bom ? {...fact,text:fact.text.replace(/^\uFEFF/u,'')} : fact; }

  show(updateId, { projectId }) {
    const record = this.#readRecord(updateId);
    if (record.project_id !== projectId) throw conflict('Document Update does not belong to this Project.');
    let current = null;
    try {
      const snapshot = record.patch.kind==='whole_text' ? this.#manualResource(projectId,record.resource_id,record.resource.file_id) : this.#resource(projectId, record.resource_id);
      if (snapshot.location_id !== record.resource.location_id || snapshot.relative_path !== record.resource.relative_path) {
        throw conflict('The Resource location changed after this Document Update was prepared.');
      }
      current = snapshot;
    } catch (error) {
      if (error.code !== 'ATLAS_STATE_CONFLICT') throw error;
      return this.#present(record, null);
    }
    return this.#present(record, current);
  }

  decide(updateId, { projectId, expectedRevision, expectedCurrentSha256, decision, text = '', requestKey, caller }) {
    const normalizedCaller = validateCaller(caller, requestKey);
    if (!['keep-current', 'accept-suggestion', 'revise'].includes(decision)) throw conflict('Document Update decision must be keep-current, accept-suggestion, or revise.');
    const revisedBlock = decision === 'revise' ? requireText(text, 'Revised text block', { allowEmpty: false }) : '';
    const decisionKey = sha256(`${normalizedCaller.tool}\0${normalizedCaller.client_run_id}\0${requestKey.trim()}`);
    const decisionPayloadDigest = requestDigest({ update_id: updateId, project_id: projectId, expected_revision: expectedRevision,
      expected_current_sha256: expectedCurrentSha256, decision, text: revisedBlock });
    return withStateLock(this.stateDir, () => {
      const record = this.#readRecord(updateId);
      if (record.project_id !== projectId) throw conflict('Document Update does not belong to this Project.');
      if(record.patch.kind==='whole_text')throw conflict('Whole-text manual edits require confirmManual, not block decisions.');
      if(record.patch.kind==='link_repair'&&decision==='revise')throw conflict('Link repair accepts only keep-current or accept-suggestion.');
      if(decision!=='keep-current'||!record.source.kind)this.#checkSource(projectId,record.source);
      if (record.pending || ['applied', 'undone'].includes(record.status)) throw conflict('This Document Update requires recovery or a new preview before another decision.');
      const previousRequest = record.decision_requests?.[decisionKey];
      if (previousRequest) {
        if (previousRequest.digest !== decisionPayloadDigest) throw conflict('This Document Update decision key was already used for different facts.');
        return this.show(updateId, { projectId });
      }
      if (record.revision !== expectedRevision) throw conflict('Document Update revision changed; reload its current preview.');
      let current;
      try { current = this.#resource(projectId, record.resource_id); } catch { throw conflict('The current text Resource is unavailable.'); }
      if (current.location_id !== record.resource.location_id || current.relative_path !== record.resource.relative_path) {
        throw conflict('The Resource location changed after this Document Update was prepared.');
      }
      if (!/^[a-f0-9]{64}$/u.test(expectedCurrentSha256 ?? '') || current.sha256 !== expectedCurrentSha256) {
        throw conflict('The text Resource changed after the preview; inspect its current version again.');
      }
      let candidateText;
      if (decision === 'keep-current') candidateText = current.text;
      else if (decision === 'accept-suggestion') {
        if (current.sha256 !== record.baseline.sha256) throw conflict('The suggestion is stale because the text changed after its preview.');
        candidateText = record.proposed.text;
      } else {
        candidateText = insertBlock(current.text, record.patch.old_text, revisedBlock);
      }
      const candidateBytes = Buffer.from(candidateText, 'utf8');
      if (candidateBytes.length > MAX_MARKDOWN_BYTES) throw conflict('The saved suggestion exceeds the text file size limit.');
      const now = new Date().toISOString();
      record.revision += 1;
      record.status = 'preview_ready';
      record.updated_at = now;
      record.decision = { kind: decision, decided_at: now, based_on_revision: expectedRevision,
        ...(decision === 'revise' ? { revised_text: revisedBlock } : {}),
        current_sha256: current.sha256, candidate: { sha256: sha256(candidateBytes), bytes: candidateBytes.length, text: candidateText } };
      record.decision_requests ??= {};
      record.decision_requests[decisionKey] = { digest: decisionPayloadDigest, revision: record.revision };
      this.#writeRecord(updateId, record);
      return this.#present(record, current);
    });
  }

  #references(projectId, resourceId) {
    const entries = []; const unavailable = [];
    const projectBase = `/projects/${encodeURIComponent(projectId)}`;
    const id = (value, kind) => typeof value === 'string' && new RegExp(`^${kind}-[a-f0-9-]+$`, 'u').test(value);
    const bounded = (value) => String(value ?? '').slice(0, 256);
    const read = (kind, callback) => {
      try { callback(); } catch { unavailable.push(kind); }
    };
    read('related_resource', () => {
      const related = this.resourceControl.linkedResourceRelationships(projectId, resourceId).filter(row => row.status === 'active');
      for (const row of related) {
        const otherId = row.source_resource_id === resourceId ? row.target_id : row.source_resource_id;
        if (!id(otherId, 'RES') || !id(row.id, 'RREL')) continue;
        entries.push({ kind: 'related_resource', resource_id: otherId, relationship_id: row.id, direction: row.direction,
          title: bounded(row.source_resource_id === resourceId ? row.target_name : row.source_name),
          href: `${projectBase}/resources?resource_id=${encodeURIComponent(otherId)}` });
      }
    });
    read('work_source', () => {
      // Select by exact registered Source before limiting the returned projection.
      const rows = this.registry.ledger.db.prepare(`SELECT DISTINCT w.id FROM work_sessions w
        JOIN work_session_sources s ON s.session_id=w.id WHERE w.project_id=? AND s.resource_id=? ORDER BY w.id`).all(projectId, resourceId);
      for (const row of rows) {
        const work = this.registry.ledger.workSessions.byId(row.id);
        if (!work || work.project_id !== projectId || !id(work.session_id, 'DWT')) continue;
        for (const source of work.sources.filter(item => item.resource_id === resourceId)) {
          entries.push({ kind: 'work_source', work_id: work.session_id, source_key: source.source_key, revision: work.revision,
            version_policy: source.version_policy ?? null, title: bounded(work.intent ?? work.session_id),
            href: `/work/${encodeURIComponent(work.session_id)}` });
        }
      }
    });
    read('saved_result_source', () => {
      for (const result of this.savedWork.listForProject(projectId)) {
        if (result.project?.id !== projectId || !id(result.save_id ?? result.work_id, result.save_id ? 'SAV' : 'SWR')) continue;
        const sources = (result.sources ?? []).filter(source => source.resource_id === resourceId);
        if (!sources.length) continue;
        const saveId = result.save_id ?? result.work_id;
        const policies = [...new Set(sources.map(source => source.version_policy).filter(Boolean))].sort();
        entries.push({ kind: 'saved_result_source', save_id: saveId, resource_id: result.resource_id ?? null,
          version_policy: policies.length === 1 ? policies[0] : policies.length > 1 ? 'mixed' : null,
          title: bounded(path.basename(result.result_path ?? saveId)),
          href: result.save_id ? `/saves/${encodeURIComponent(saveId)}`
            : id(result.resource_id, 'RES') ? `${projectBase}/resources?resource_id=${encodeURIComponent(result.resource_id)}` : null });
      }
    });
    read('board_reference', () => {
      // listForProject above also reports unreadable Save metadata; no empty-success claim.
      for (const row of this.boards.listResourceReferences(projectId, resourceId)) {
        if (!id(row.board_id, 'BRD') || !id(row.block_id, 'BLK')) continue;
        entries.push({ kind: 'board_reference', board_id: row.board_id, block_id: row.block_id, revision: row.revision,
          version_policy: row.version_policy ?? null, relation: row.relation, title: bounded(row.title),
          href: `${projectBase}/boards/${encodeURIComponent(row.board_id)}` });
      }
    });
    entries.sort((left, right) => {
      const key = (entry) => [entry.kind, entry.relationship_id, entry.work_id, entry.source_key, entry.save_id, entry.board_id, entry.block_id].map(v => v ?? '').join('\0');
      return key(left).localeCompare(key(right), 'en');
    });
    return { scope: 'registered_project_references', status: unavailable.length ? 'unknown' : 'complete',
      entries: entries.slice(0, 100), known_total: entries.length, truncated: entries.length > 100,
      unavailable_kinds: unavailable, file_verification: 'not_checked',
      unregistered_references: 'not_checked', external_references: 'not_checked',
      notice: 'Registered facts only. Open referenced objects to check them. Unregistered in-text and external references were not checked; consumers were not updated.' };
  }

  #change(record, current) {
    if(record.patch.kind==='whole_text')return {kind:'whole_text',origin:'manual_editor',decision:record.decision?.kind??null};
    if(record.patch.kind==='link_repair')return {kind:'link_repair',edits:record.patch.edits,skipped:record.patch.skipped,decision:record.decision?.kind??null};
    let confirmed = record.decision?.kind === 'accept-suggestion' ? record.patch.suggested_text
      : record.decision?.kind === 'revise' ? record.decision.revised_text ?? null : null;
    // Older persisted decisions did not retain their revised block separately.
    // Derive it only from the exact recorded decision basis and complete candidate.
    if (record.decision?.kind === 'revise' && confirmed == null) {
      const basis = record.execution?.before.sha256 === record.decision.current_sha256 ? record.execution.before
        : current?.sha256 === record.decision.current_sha256 ? current
          : record.baseline.sha256 === record.decision.current_sha256 ? record.baseline : null;
      if (basis) {
        const old = record.patch.old_text; const candidate = record.decision.candidate.text;
        if (old && occurrences(basis.text, old) === 1) {
          const position = basis.text.indexOf(old); const prefix = basis.text.slice(0, position); const suffix = basis.text.slice(position + old.length);
          if (candidate.startsWith(prefix) && candidate.endsWith(suffix) && candidate.length >= prefix.length + suffix.length) {
            confirmed = candidate.slice(prefix.length, candidate.length - suffix.length);
          }
        } else if (!old) {
          const prefix = basis.text + (!basis.text || basis.text.endsWith('\n') ? '' : '\n');
          if (candidate.startsWith(prefix)) confirmed = candidate.slice(prefix.length);
        }
      }
    }
    return { kind: record.patch.kind, old_text: record.patch.old_text, suggested_text: record.patch.suggested_text,
      confirmed_text: confirmed, decision: record.decision?.kind ?? null };
  }

  #bound(record, projectId, { requireSource = true } = {}) {
    if (record.project_id !== projectId) throw conflict('Document Update does not belong to this Project.');
    if((record.source?.kind==='manual_edit')!==(record.patch.kind==='whole_text'))throw conflict('Manual source and whole-text patch must be paired.');
    assertRecoveryWritable(this.resourceControl.ledger.db, { projectId, resourceId: record.resource_id });
    const current = this.#resource(projectId, record.resource_id);
    if(record.patch.kind==='whole_text') {
      this.#checkSource(projectId,record.source,{allowManual:true});
      this.#manualGuards(projectId,record.resource_id,record.update_id);
      const manual=this.#manualResource(projectId,record.resource_id,record.resource.file_id);
      if(manual.root_id!==record.resource.root_id || manual.root_identity!==record.resource.root_identity)throw conflict('Manual Resource Root identity changed.');
    }
    if (current.location_id !== record.resource.location_id || current.relative_path !== record.resource.relative_path
      || record.resource.path && current.path !== record.resource.path
      || record.resource.root_path && current.root_path !== record.resource.root_path) {
      throw conflict('Document Update Resource location or root changed.');
    }
    if (requireSource) {
      this.#checkSource(projectId,record.source,{allowManual:record.patch.kind==='whole_text'});
    }
    return current;
  }

  #finish(record, pending) {
    const ledger = this.resourceControl.ledger;
    ledger.transaction(() => {
      const prior = ledger.db.prepare('SELECT id FROM resource_actions WHERE id=?').get(pending.operation_id);
      if (prior) return;
      ledger.resources.refreshLocation(record.resource.location_id, { path: pending.target, sha256: pending.after.sha256,
        bytes: pending.after.bytes, modified_at: pending.created_at });
      ledger.resources.recordAction({ id: pending.operation_id, resourceId: record.resource_id,
        type: `document_update_${pending.kind}`, at: pending.created_at, details: {
          project_id: record.project_id, update_id: record.update_id, source: record.source,
          before_sha256: pending.before.sha256, after_sha256: pending.after.sha256,
          file_id: pending.file_id, caller: pending.caller,
        } });
    });
    this.operationHook('after-ledger', { operation_id: pending.operation_id });
    Object.assign(record,this.#finalRecord(record,pending));
    this.#writeRecord(record.update_id, record);
  }

  #finalRecord(input,pending) {
    const record=structuredClone(input);
    if (pending.kind === 'execute') record.execution = {
      operation_id: pending.operation_id, file_id: pending.file_id, before: pending.before, after: pending.after,
    };
    record.status = pending.kind === 'execute' ? 'applied' : 'undone';
    record.operation_requests[pending.key].status = record.status;
    record.operation_requests[pending.key].receipt = {
      operation_id: pending.operation_id, kind: pending.kind, created_at: pending.created_at,
      caller: pending.caller, before_sha256: pending.before.sha256, after_sha256: pending.after.sha256,
      before_bytes: pending.before.bytes, after_bytes: pending.after.bytes, file_id: pending.file_id,
    };
    record.pending = null; record.revision += 1; record.updated_at = new Date().toISOString();
    return record;
  }

  #mutate(kind, updateId, { projectId, expectedRevision, expectedCurrentSha256, requestKey, caller }) {
    return withStateLock(this.stateDir, () => this.#mutateLocked(kind, updateId, { projectId, expectedRevision, expectedCurrentSha256, requestKey, caller }));
  }

  #mutateLocked(kind, updateId, { projectId, expectedRevision, expectedCurrentSha256, requestKey, caller, expectedFileId = null, manualConfirmed = false }) {
    const normalizedCaller = validateCaller(caller, requestKey);
    const key = requestKeyId(projectId, normalizedCaller, requestKey.trim());
    const digest = requestDigest({ kind, updateId, projectId, expectedRevision, expectedCurrentSha256 });
      const record = this.#readRecord(updateId);
      if (record.project_id !== projectId) throw conflict('Document Update does not belong to this Project.');
      if(record.patch.kind==='whole_text' && kind==='execute' && !manualConfirmed)throw conflict('Manual whole-text Save requires confirmManual.');
      const previous = record.operation_requests?.[key];
      if (previous) {
        if (previous.digest !== digest) throw conflict('This Document Update operation key was used for different facts.');
        return this.show(updateId, { projectId });
      }
      if (record.pending) throw conflict('Document Update was interrupted. Recover it explicitly before another operation.');
      if (record.revision !== expectedRevision) throw conflict('Document Update revision changed; reload it.');
      const current = this.#bound(record, projectId, { requireSource: kind === 'execute' });
      if (!/^[a-f0-9]{64}$/u.test(expectedCurrentSha256 ?? '') || current.sha256 !== expectedCurrentSha256) {
        throw conflict('Document Update current hash changed; reload it.');
      }
      if (kind === 'execute' && (record.status !== 'preview_ready'
        || !['accept-suggestion', 'revise'].includes(record.decision?.kind)
        || record.decision.current_sha256 !== expectedCurrentSha256)) {
        throw conflict('Confirm an accepted or revised current suggestion before applying it.');
      }
      if (kind === 'undo' && (record.status !== 'applied' || record.execution?.after.sha256 !== expectedCurrentSha256)) {
        throw conflict('Undo refuses later document changes.');
      }
      const inspected = this.writer({ mode: 'inspect', root: current.root_path, target: current.path,
        expectedSha256: expectedCurrentSha256, ...(kind === 'undo' ? { expectedFileId: record.execution.file_id } : expectedFileId ? { expectedFileId } : {}) });
      const before = { text: inspected.text, sha256: inspected.sha256, bytes: inspected.bytes };
      const after = kind === 'execute' ? record.decision.candidate : record.execution.before;
      const pending = { kind, operation_id: `RACT-${crypto.randomUUID()}`, key, digest,
        target: current.path, root: current.root_path, file_id: inspected.file_id,
        before, after, caller: normalizedCaller, created_at: new Date().toISOString() };
      record.resource.path = current.path; record.resource.root_path = current.root_path;
      record.operation_requests ??= {}; record.operation_requests[key] = { digest, operation_id: pending.operation_id, status: 'pending' };
      record.pending = pending; record.status = 'pending_recovery'; record.revision += 1;
      if(record.patch.kind==='whole_text') {
        for(const value of [record,this.#finalRecord(record,pending)])if(Buffer.byteLength(`${JSON.stringify(value,null,2)}\n`,'utf8')>MAX_STATE_BYTES)throw conflict('Manual pending or final serialized state exceeds its storage limit.');
      }
      this.#writeRecord(updateId, record);
      this.operationHook('before-write', { operation_id: pending.operation_id });
      const result = this.writer({ mode: 'replace', root: pending.root, target: pending.target,
        expectedFileId: pending.file_id, expectedSha256: before.sha256, text: after.text });
      if (result.file_id !== pending.file_id || result.sha256 !== after.sha256 || result.bytes !== after.bytes) {
        throw conflict('Document Update writer result differs from the journal. Recover explicitly.');
      }
      this.operationHook('after-write', { operation_id: pending.operation_id });
      this.#finish(record, pending);
      return this.show(updateId, { projectId });
  }

  execute(updateId, options) { return this.#mutate('execute', updateId, options); }
  undo(updateId, options) { return this.#mutate('undo', updateId, options); }

  #batchDirectory() {
    assertNoLinkPath(this.stateDir);
    const directory = path.join(this.stateDir, 'document-update-batches');
    try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertNoLinkPath(directory);
    if (!fs.lstatSync(directory).isDirectory()) throw conflict('Batch journal is not a directory.');
    return directory;
  }

  #batchFile(batchId) {
    if (!/^BUP-[a-f0-9]{32}$/u.test(batchId ?? '')) throw conflict('Text update batch ID is invalid.');
    return path.join(this.#batchDirectory(), `${batchId}.json`);
  }

  #readBatch(batchId) {
    const file = this.#batchFile(batchId); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw conflict('Batch journal is not a bounded regular record.');
    let batch;
    try { batch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw conflict('Batch journal is unreadable.'); }
    if (batch.schema !== 'atlas.document-update-batch.v1' || batch.batch_id !== batchId
      || !Array.isArray(batch.manifest) || !batch.manifest.length || batch.manifest.length > 20
      || requestDigest(batch.manifest) !== batch.manifest_digest || !Array.isArray(batch.items)
      || batch.items.length !== batch.manifest.length || !Number.isInteger(batch.revision)
      || batch.items.some(item => !['ready', 'started', 'needs_recovery', 'paused', 'applied', 'blocked'].includes(item?.status))
      || !batch.advance_requests || !Array.isArray(batch.recovery_basis)) throw conflict('Batch journal identity or manifest is invalid.');
    return batch;
  }

  #writeBatch(batch, { create = false } = {}) {
    const file = this.#batchFile(batch.batch_id); const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(batch, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_STATE_BYTES) throw conflict('Batch journal exceeds 2 MiB.');
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = null; assertNoLinkPath(path.dirname(file));
      if (create) fs.linkSync(temporary, file);
      else { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('Batch journal was replaced.'); fs.renameSync(temporary, file); }
    } finally { if (descriptor != null) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
  }

  #roundBasis(projectId) {
    return this.resourceControl.ledger.db.prepare('SELECT id,revision,state_json FROM recovery_rounds WHERE project_id=? ORDER BY id').all(projectId).map(row => {
      let state;
      try { state = JSON.parse(row.state_json); } catch { throw conflict('Recovery history is unreadable.'); }
      if (state.project_id !== projectId || state.round_id !== row.id || state.revision !== row.revision) throw conflict('Recovery history identity is invalid.');
      return { round_id: row.id, revision: row.revision, head_node_id: state.head_node_id };
    });
  }

  #batchDigest(batch) { return requestDigest({ manifest_digest: batch.manifest_digest, revision: batch.revision, items: batch.items, status: batch.status }); }

  #presentBatch(batch) {
    const projectId = batch.project_id;
    const items = batch.manifest.map((item, index) => {
      let current = null; let notice = null; let references = null; let updateStatus = null;
      try { const shown = this.show(item.update_id, { projectId }); current = shown.current; references = shown.references; updateStatus = shown.status; }
      catch (error) { notice = String(error.message).slice(0, 500); }
      return { ...item, ...batch.items[index], observed_current_sha256: current?.sha256 ?? null,
        update_status: updateStatus,
        current_deviation: batch.items[index].status === 'applied' && (updateStatus === 'undone' || current?.sha256 !== item.candidate_sha256),
        notice, href: `/projects/${encodeURIComponent(projectId)}/document-updates/${item.update_id}`,
        work_references: (references?.entries ?? []).filter(entry => entry.kind === 'work_source'),
        work_status: 'not_run' };
    });
    return { ...batch, digest: this.#batchDigest(batch), items,
      successful_count: batch.items.filter(item => item.status === 'applied').length,
      blocked_count: batch.items.filter(item => item.status === 'blocked').length,
      remaining_count: batch.items.filter(item => item.status !== 'applied' && item.status !== 'blocked').length,
      history_changed: requestDigest(this.#roundBasis(projectId)) !== requestDigest(batch.recovery_basis) };
  }

  listReviewedUpdates({ projectId }) {
    this.registry.show(projectId);
    const files = fs.readdirSync(this.#storeDirectory()).filter(name => /^UPD-[a-f0-9]{32}\.json$/u.test(name)).sort();
    if (files.length > 10000) throw conflict('Text update selection exceeds the journal inspection budget.');
    const entries = [];
    for (const file of files) {
      const record = this.#readRecord(file.slice(0, -5));
      if (record.patch.kind==='whole_text' || record.project_id !== projectId || record.pending || record.status !== 'preview_ready' || !['accept-suggestion', 'revise'].includes(record.decision?.kind)) continue;
      let shown;
      try { shown = this.show(record.update_id, { projectId }); } catch { continue; }
      if (shown.current?.sha256 !== record.decision.current_sha256) continue;
      entries.push({ update_id: record.update_id, resource_id: record.resource_id, revision: record.revision,
        relative_path: record.resource.relative_path, current_sha256: record.decision.current_sha256,
        candidate_sha256: record.decision.candidate.sha256, source: record.source });
    }
    return { project_id: projectId, entries: entries.slice(0, 100), known_total: entries.length, truncated: entries.length > 100, limit: 100 };
  }

  prepareBatch({ projectId, items, requestKey, caller }) {
    const normalizedCaller = validateCaller(caller, requestKey);
    if (!Array.isArray(items) || !items.length || items.length > 20 || new Set(items.map(item => item?.updateId)).size !== items.length) throw conflict('Select 1–20 distinct reviewed text updates with explicit reviewed facts.');
    const selections = items.map(item => {
      if (!/^UPD-[a-f0-9]{32}$/u.test(item?.updateId ?? '') || !Number.isInteger(item.expectedRevision)
        || !/^[a-f0-9]{64}$/u.test(item.expectedCurrentSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(item.expectedCandidateSha256 ?? '')) throw conflict('Batch selection requires the displayed revision, current Hash and candidate Hash.');
      return { updateId: item.updateId, expectedRevision: item.expectedRevision, expectedCurrentSha256: item.expectedCurrentSha256, expectedCandidateSha256: item.expectedCandidateSha256 };
    });
    const batchId = `BUP-${requestKeyId(projectId, normalizedCaller, requestKey.trim())}`;
    const digest = requestDigest({ project_id: projectId, items: selections });
    return withStateLock(this.stateDir, () => {
      const file = this.#batchFile(batchId);
      if (fs.existsSync(file)) {
        const existing = this.#readBatch(batchId);
        if (existing.request_digest !== digest) throw conflict('Batch request key was used with different facts.');
        return this.#presentBatch(existing);
      }
      assertRecoveryWritable(this.resourceControl.ledger.db, { projectId });
      const resources = new Set();
      const manifest = selections.map(selection => {
        const updateId = selection.updateId;
        const record = this.#readRecord(updateId);
        if(record.patch.kind==='whole_text')throw conflict('Manual whole-text edits cannot enter batch execution.');
        if (record.pending || record.status !== 'preview_ready' || !['accept-suggestion', 'revise'].includes(record.decision?.kind)) throw conflict('Only accepted or revised current suggestions can enter a batch.');
        if (record.revision !== selection.expectedRevision || record.decision.current_sha256 !== selection.expectedCurrentSha256
          || record.decision.candidate.sha256 !== selection.expectedCandidateSha256) throw conflict('The displayed batch selection changed; review the current suggestions again.');
        const current = this.#bound(record, projectId);
        if (resources.has(record.resource_id)) throw conflict('A batch cannot include the same Resource twice.');
        resources.add(record.resource_id);
        if (current.sha256 !== record.decision.current_sha256) throw conflict('The reviewed text update is stale.');
        const inspected = this.writer({ mode: 'inspect', root: current.root_path, target: current.path, expectedSha256: current.sha256 });
        return { update_id: updateId, revision: record.revision, resource_id: record.resource_id,
          current_sha256: current.sha256, candidate_sha256: record.decision.candidate.sha256,
          path: current.path, root_path: current.root_path, relative_path: current.relative_path, location_id: current.location_id,
          source: record.source, file_id: inspected.file_id,
          request_key: `batch-${batchId}-${updateId}`, caller: { tool: 'atlas-text-update-batch', client_run_id: batchId } };
      });
      const batch = { schema: 'atlas.document-update-batch.v1', batch_id: batchId, project_id: projectId,
        manifest, manifest_digest: requestDigest(manifest), request_digest: digest, request_key: requestKey.trim(), caller: normalizedCaller,
        recovery_basis: this.#roundBasis(projectId), revision: 1, status: 'ready', created_at: new Date().toISOString(),
        items: manifest.map(() => ({ status: 'ready' })), advance_requests: {} };
      this.#writeBatch(batch, { create: true }); return this.#presentBatch(batch);
    });
  }

  showBatch(batchId, { projectId }) {
    const batch = this.#readBatch(batchId);
    if (batch.project_id !== projectId) throw conflict('Text update batch belongs to another Project.');
    return this.#presentBatch(batch);
  }

  advanceBatch(batchId, { projectId, expectedRevision, expectedDigest, requestKey, caller }) {
    const normalizedCaller = validateCaller(caller, requestKey);
    const key = requestKeyId(projectId, normalizedCaller, requestKey.trim());
    const digest = requestDigest({ batchId, projectId, expectedRevision, expectedDigest });
    return withStateLock(this.stateDir, () => {
      const batch = this.#readBatch(batchId);
      if (batch.project_id !== projectId) throw conflict('Text update batch belongs to another Project.');
      const previous = batch.advance_requests[key];
      if (previous && previous.digest !== digest) throw conflict('Batch advance key was used with different facts.');
      if (previous?.completed) return this.#presentBatch(batch);
      if (!previous && (batch.revision !== expectedRevision || this.#batchDigest(batch) !== expectedDigest)) throw conflict('Batch revision or digest changed; read it again.');
      assertRecoveryWritable(this.resourceControl.ledger.db, { projectId });
      if (requestDigest(this.#roundBasis(projectId)) !== requestDigest(batch.recovery_basis)) throw conflict('Recovery history changed. Review remaining suggestions and create a new batch.');
      const index = batch.items.findIndex(item => ['started', 'needs_recovery', 'paused'].includes(item.status));
      const selected = previous ? previous.item_index : index >= 0 ? index : batch.items.findIndex(item => item.status === 'ready');
      if (selected < 0) {
        batch.advance_requests[key] = { digest, caller: normalizedCaller, completed: true, item_index: null };
        batch.revision++; batch.updated_at = new Date().toISOString(); this.#writeBatch(batch);
        return this.#presentBatch(batch);
      }
      if (!Number.isInteger(selected) || !batch.items[selected]) throw conflict('Batch advance journal item is invalid.');
      const frozen = batch.manifest[selected]; const progress = batch.items[selected];
      const operationKey = requestKeyId(projectId, frozen.caller, frozen.request_key);
      let record;
      try { record = this.#readRecord(frozen.update_id); }
      catch (error) { progress.status = 'paused'; progress.reason = String(error.message).slice(0, 500); }
      batch.advance_requests[key] = { digest, caller: normalizedCaller, completed: false, item_index: selected };
      const save = () => {
        batch.status = batch.items.some(item => ['needs_recovery', 'paused', 'started'].includes(item.status)) ? 'paused'
          : batch.items.some(item => item.status === 'ready') ? 'ready' : 'finished';
        batch.revision++; batch.updated_at = new Date().toISOString(); batch.advance_requests[key].completed = true;
        this.#writeBatch(batch); return this.#presentBatch(batch);
      };
      if (!record) return save();
      const priorOperation = record.operation_requests?.[operationKey];
      if (priorOperation && ['applied', 'undone'].includes(priorOperation.status) && record.execution?.operation_id === priorOperation.operation_id
        && record.execution.after.sha256 === frozen.candidate_sha256 && record.execution.file_id === frozen.file_id) {
        progress.status = 'applied'; progress.operation_id = priorOperation.operation_id; progress.reconciled = true; return save();
      }
      if (record.pending) { progress.status = 'needs_recovery'; progress.reason = 'Open the single text update and recover it explicitly.'; return save(); }
      if (priorOperation?.status === 'not_applied' || !record.decision) { progress.status = 'blocked'; progress.reason = 'review_required'; return save(); }
      let current;
      try {
        if (record.project_id !== projectId || record.resource_id !== frozen.resource_id) throw conflict('Batch target identity changed.');
        current = this.#resource(projectId, frozen.resource_id);
        if (current.path !== frozen.path || current.root_path !== frozen.root_path || current.location_id !== frozen.location_id) throw conflict('Batch target location or identity changed.');
        this.writer({ mode: 'inspect', root: frozen.root_path, target: frozen.path, expectedFileId: frozen.file_id, expectedSha256: current.sha256 });
      } catch (error) { progress.status = 'paused'; progress.reason = String(error.message).slice(0, 500); return save(); }
      try {
        if (record.revision !== frozen.revision || record.decision.candidate.sha256 !== frozen.candidate_sha256 || current.sha256 !== frozen.current_sha256) throw conflict('Frozen reviewed suggestion or current text changed.');
        const source = this.#typedSource(projectId, frozen.source);
        if (requestDigest(source) !== requestDigest(frozen.source)) throw conflict('Frozen source changed.');
      } catch (error) { progress.status = 'blocked'; progress.reason = String(error.message).slice(0, 500); return save(); }
      progress.status = 'started'; batch.status = 'paused'; batch.revision++;
      this.#writeBatch(batch);
      this.operationHook('batch-started', { batch_id: batchId, update_id: frozen.update_id });
      try {
        this.#mutateLocked('execute', frozen.update_id, { projectId, expectedRevision: frozen.revision,
          expectedCurrentSha256: frozen.current_sha256, expectedFileId: frozen.file_id,
          requestKey: frozen.request_key, caller: frozen.caller });
      } catch (error) {
        // Preserve started intent on interruption. No implicit retry or recovery.
        throw error;
      }
      this.operationHook('batch-after-update', { batch_id: batchId, update_id: frozen.update_id });
      record = this.#readRecord(frozen.update_id);
      if (record.status !== 'applied' || !record.execution) throw conflict('Batch update did not reach its final applied state.');
      progress.status = 'applied'; progress.operation_id = record.execution.operation_id; return save();
    });
  }

  recover(updateId, { projectId, expectedRevision, expectedCurrentSha256, requestKey, caller }) {
    const normalizedCaller = validateCaller(caller, requestKey);
    const key = requestKeyId(projectId, normalizedCaller, requestKey.trim());
    const digest = requestDigest({ kind: 'recover', updateId, projectId, expectedRevision, expectedCurrentSha256 });
    return withStateLock(this.stateDir, () => {
      const record = this.#readRecord(updateId);
      if (record.project_id !== projectId) throw conflict('Document Update does not belong to this Project.');
      const previous = record.operation_requests?.[key];
      if (previous) {
        if (previous.digest !== digest) throw conflict('This recovery key was used for different facts.');
        return this.show(updateId, { projectId });
      }
      if (!record.pending || record.revision !== expectedRevision) throw conflict('Reload the pending Document Update before recovery.');
      const pending = record.pending;
      const current = this.#bound(record, projectId, { requireSource: false });
      const inspected = this.writer({ mode: 'inspect', root: pending.root, target: pending.target,
        expectedFileId: pending.file_id, expectedSha256: expectedCurrentSha256 });
      if (current.sha256 !== inspected.sha256) throw conflict('Document changed during recovery inspection.');
      const committedAction = this.resourceControl.ledger.db.prepare('SELECT id FROM resource_actions WHERE id=?').get(pending.operation_id);
      if (committedAction && inspected.sha256 !== pending.after.sha256) {
        throw conflict('Recovery found later changes after a recorded application. The pending operation is retained.');
      }
      record.operation_requests[key] = { digest, operation_id: pending.operation_id, status: 'recovered' };
      if (inspected.sha256 === pending.after.sha256) {
        record.recovery = { outcome: 'applied', operation_id: pending.operation_id };
        this.#finish(record, pending);
      } else if (inspected.sha256 === pending.before.sha256) {
        // No write is retried by recovery. A new decision is required for execute.
        record.operation_requests[pending.key].status = 'not_applied';
        record.pending = null; record.status = pending.kind === 'undo' ? 'applied' : 'preview_ready';
        if (pending.kind === 'execute') record.decision = null;
        record.recovery = { outcome: 'not_applied', operation_id: pending.operation_id };
        record.revision += 1; record.updated_at = new Date().toISOString();
        this.#writeRecord(updateId, record);
      } else throw conflict('Recovery found a third document version; no state or document write was applied.');
      return this.show(updateId, { projectId });
    });
  }
}

export function createDocumentUpdateService(options) { return new DocumentUpdateService(options); }
