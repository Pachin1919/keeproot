#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { Derived } from '../src/derived.js';
import { Evolution } from '../src/evolution.js';
import { Guarded } from '../src/guarded.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { evaluateRisk } from '../src/risk.js';
import { normalizeStateDir } from '../src/paths.js';
import { RuntimeStorage } from '../src/runtime-storage.js';
import { TaskContract } from '../src/task-contract.js';
import {
  ATLAS_VERSION,
  CAPABILITIES,
  callerFromOptions,
  errorEnvelope,
  successEnvelope,
} from '../src/protocol.js';
import { RollbackConflictError, Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDirInput = process.env.ATLAS_STATE_DIR
  ? path.resolve(process.env.ATLAS_STATE_DIR)
  : path.join(projectRoot, '.atlas');
let stateDir = stateDirInput;
let outputJson = false;
let activeCommand = null;

function emit(command, data, printHuman) {
  activeCommand = command;
  if (outputJson) console.log(JSON.stringify(successEnvelope(command, data), null, 2));
  else printHuman(data);
  return data;
}

const callerFlags = new Map([
  ['--actor', 'actor'],
  ['--agent', 'agent'],
  ['--model', 'model'],
  ['--tool', 'tool'],
  ['--client-run-id', 'clientRunId'],
]);

function parseCallerFlag(result, args, index) {
  const field = callerFlags.get(args[index]);
  if (!field) return null;
  if (args[index + 1] === undefined) throw new Error(`${args[index]} requires a value`);
  result[field] = args[index + 1];
  return index + 1;
}

function usage() {
  return `Atlas 0.1 — local-first file governance foundation

Usage:
  atlas version [--json]
  atlas capabilities [--json]
  atlas doctor [--json]
  atlas begin --root <path> --allow <path> [--allow <path> ...] [--intent <text>]
              [--operation <type>] [--importance <level>] [--link-impact <count>] [--confidence <0..1>] [--rules]
  atlas close [run_id]
  atlas abort <run_id> [--reason <text>]
  atlas status
  atlas show <run_id> [--json]
  atlas rollback <run_id>
  atlas gc [--older-than-hours <number>]
  atlas storage status | plan | execute [--older-than-hours <number>]
  atlas work stage --file <path> --kind <candidate|proposal|intermediate> [--ttl-hours <number>]
  atlas work status [work_id] | release <work_id> [--reason <text>]
  atlas bootstrap profiles
  atlas bootstrap scan --root <path> [--ignore <relative_directory> ...]
                       [--scan-mode <structure|metadata>] [--new]
  atlas bootstrap recommend <scan_id> [--profile <profile_id>]
  atlas bootstrap contract <scan_id> [--profile <profile_id>]
  atlas bootstrap adopt <scan_id> --contract <contract_id> [--profile <profile_id>] --reason <text>
  atlas bootstrap context <scan_id> [--max-samples <1..20>]
  atlas bootstrap propose <scan_id> --proposal-file <json>
  atlas bootstrap status
  atlas bootstrap show <scan_id> [--json]
  atlas bootstrap review <prediction_id> (--accept | --reject | --correct) [--reason <text>]
  atlas bootstrap initialize <scan_id>
  atlas intake prepare --root <path> --candidate-file <path> --origin <origin>
                       [--kind <kind>] [--filename <name>] [--project <project_id>]
                       [--input <related_path> ...] [--intent <text>]
  atlas intake show <run_id>
  atlas intake execute <run_id> --reason <task_authorization>
  atlas intake rollback <run_id>
  atlas task prepare --root <path> --request-file <json> [agent options]
  atlas task show <task_id>
  atlas task fulfill <task_id> --candidate-file <path> [--reason <task_authorization>]
  atlas task complete <task_id> --run <derived_or_guarded_run_id>
  atlas task rollback <task_id>
  atlas evolve prepare --root <path> --operation <create_directory|move_file|migrate_project>
                       [--source <path>] --target <path> [--project <project_id>] [--intent <text>]
  atlas evolve preview <run_id>
  atlas evolve approve | reject <run_id> [--reason <text>]
  atlas evolve execute | rollback <run_id>
  atlas risk --operation <type> --path <path> [--count <number>] [--rules] [--no-recovery]
  atlas rule list | show <rule_version_id>
  atlas project create --name <name> --path <relative_path> [--alias <name> ...]
  atlas project list | show <project_id> | evolve <project_id> [--name <name>] [--alias <name>] [--status <status>]
  atlas project move <project_id> --path <relative_path> [--name <name>]
  atlas guarded prepare --root <path> --target <path> --candidate-file <path> [--intent <text>]
  atlas guarded preview <run_id> [--json]
  atlas guarded approve | reject <run_id> [--reason <text>]
  atlas guarded revise <run_id> --candidate-file <path> [--reason <text>]
  atlas guarded execute | rollback <run_id>
  atlas derive prepare --root <path> --input <path> [--input <path> ...]
                       --target <new_path> --candidate-file <path>
                       --project <project_id> --role <role> [--relation <type>] [--intent <text>]
  atlas derive preview <run_id> [--json]
  atlas derive recommend --root <path> --input <path> [--input <path> ...]
                         --role <role> --filename <name> [--project <project_id>]
  atlas derive approve | reject <run_id> [--reason <text>]
  atlas derive revise <run_id> [--target <new_path>] [--role <role>]
                      [--candidate-file <path>] [--reason <text>]
  atlas derive promote <run_id> --role <role> [--reason <text>]
  atlas derive execute | rollback <run_id>

Agent options for run-producing commands:
  --actor <type> --agent <name> --model <name> --tool <name> --client-run-id <id>

Pass --json to any command for the stable ${CAPABILITIES.protocol_version} envelope.
`;
}

function parseBegin(args) {
  const result = { allow: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--root') result.root = args[++index];
    else if (token === '--allow') result.allow.push(args[++index]);
    else if (token === '--intent') result.intent = args[++index];
    else if (token === '--operation') result.operation = args[++index];
    else if (token === '--importance') result.targetImportance = args[++index];
    else if (token === '--link-impact') result.linkImpact = Number(args[++index]);
    else if (token === '--confidence') result.predictionConfidence = Number(args[++index]);
    else if (token === '--rules') result.modifiesRules = true;
    else {
      const consumed = parseCallerFlag(result, args, index);
      if (consumed == null) throw new Error(`Unknown begin argument: ${token}`);
      index = consumed;
    }
  }
  if (result.allow.some((value) => value === undefined)) {
    throw new Error('--allow requires a path');
  }
  result.caller = callerFromOptions(result);
  return result;
}

function printBegin(receipt) {
  console.log(`Began ${receipt.run_id}: baseline ${receipt.baseline_files} file(s); ${receipt.allowed_scopes.length} allowed scope(s).`);
  console.log(`Root: ${receipt.root}`);
}

function printClose(receipt) {
  const scope = receipt.policy === 'pass'
    ? 'scope and risk OK'
    : receipt.violation_kind === 'risk'
      ? `risk escalation to ${receipt.actual_risk_mode}`
      : `${receipt.scope_violations.length} scope violation(s)`;
  console.log(`Closed ${receipt.run_id}: ${receipt.changed_files} changed file(s); ${scope}; rollback ready.`);
  if (receipt.scope_violations.length) {
    console.log(`Outside scope: ${receipt.scope_violations.join(', ')}`);
  }
  console.log(`Diff: sha256:${receipt.diff_sha256}`);
}

function printStatus(rows) {
  if (!rows.length) {
    console.log('No Atlas runs.');
    return;
  }
  console.log('RUN_ID\tSTATUS\tSTARTED_AT\tROOT');
  for (const row of rows) {
    console.log(`${row.id}\t${row.status}\t${row.started_at}\t${row.root_path}`);
  }
}

function parseAbort(args) {
  const runId = args[0];
  if (!runId || runId.startsWith('--')) throw new Error('abort requires a run_id');
  let reason = 'aborted by caller';
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--reason' && args[index + 1] !== undefined) {
      reason = args[++index];
    } else {
      throw new Error(`Unknown abort argument: ${args[index]}`);
    }
  }
  return { runId, reason };
}

function parseAgeOptions(args, defaultHours = 24) {
  let hours = defaultHours;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--older-than-hours' && args[index + 1] !== undefined) {
      hours = Number(args[++index]);
    } else {
      throw new Error(`Unknown age argument: ${args[index]}`);
    }
  }
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error('--older-than-hours must be a non-negative number');
  }
  return { minAgeMs: hours * 60 * 60 * 1000 };
}

function parseGc(args) {
  return parseAgeOptions(args, 24);
}

function printShow(detail) {
  console.log(`Run: ${detail.run.id}`);
  console.log(`Status: ${detail.run.status}`);
  console.log(`Mode: ${detail.run.mode}`);
  console.log(`Root: ${detail.run.root_path}`);
  console.log(`Intent: ${detail.run.intent ?? '-'}`);
  console.log(`Scopes: ${detail.scopes.map((scope) => `${scope.kind}:${scope.path || '.'}`).join(', ')}`);
  console.log(`Changes: ${detail.changes.length}`);
  for (const change of detail.changes) {
    console.log(`  ${change.allowed ? 'ALLOW' : 'DENY '} ${change.changeType.padEnd(8)} ${change.path}`);
  }
  if (detail.decisions.length) {
    console.log(`Policy: ${detail.decisions.at(-1).decision} — ${detail.decisions.at(-1).reason}`);
  }
  console.log('Events:');
  for (const event of detail.events) {
    console.log(`  ${event.occurred_at} ${event.type}`);
  }
  if (detail.change_set.diff_text) {
    console.log('Diff:');
    process.stdout.write(detail.change_set.diff_text);
  }
}

function parseBootstrapScan(args) {
  const result = { ignore: [], scanMode: 'metadata', forceNew: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') result.root = args[++index];
    else if (args[index] === '--ignore') result.ignore.push(args[++index]);
    else if (args[index] === '--scan-mode') result.scanMode = args[++index];
    else if (args[index] === '--new') result.forceNew = true;
    else {
      const consumed = parseCallerFlag(result, args, index);
      if (consumed == null) throw new Error(`Unknown bootstrap scan argument: ${args[index]}`);
      index = consumed;
    }
  }
  if (!result.root || result.ignore.some((item) => item == null) || !result.scanMode) {
    throw new Error('bootstrap scan requires --root <path>; --ignore and --scan-mode require values');
  }
  result.caller = callerFromOptions(result);
  return result;
}

function parseBootstrapReview(args) {
  const predictionId = args[0];
  if (!predictionId || predictionId.startsWith('--')) {
    throw new Error('bootstrap review requires a prediction_id');
  }
  let decision = null;
  let reason = null;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--accept') decision = 'accepted';
    else if (token === '--reject') decision = 'rejected';
    else if (token === '--correct') decision = 'corrected';
    else if (token === '--reason' && args[index + 1] !== undefined) reason = args[++index];
    else throw new Error(`Unknown bootstrap review argument: ${token}`);
  }
  if (!decision) throw new Error('bootstrap review requires --accept, --reject, or --correct');
  return { predictionId, decision, reason };
}

function readJsonFile(filePath, purpose) {
  if (!filePath) throw new Error(`${purpose} requires a JSON file path`);
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${purpose} file does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${purpose} must be a regular non-symbolic-link file: ${absolute}`);
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`${purpose} file is too large; maximum is 2 MiB`);
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${purpose} is not valid JSON: ${error.message}`);
  }
}

function parseBootstrapContext(args) {
  const scanId = args[0];
  if (!scanId || scanId.startsWith('--')) throw new Error('bootstrap context requires a scan_id');
  let maxSamples = 5;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--max-samples' && args[index + 1] !== undefined) {
      maxSamples = Number(args[++index]);
    } else {
      throw new Error(`Unknown bootstrap context argument: ${args[index]}`);
    }
  }
  return { scanId, maxSamples };
}

function parseBootstrapPropose(args) {
  const scanId = args[0];
  if (!scanId || scanId.startsWith('--')) throw new Error('bootstrap propose requires a scan_id');
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--proposal-file') options.proposalFile = args[++index];
    else {
      const consumed = parseCallerFlag(options, args, index);
      if (consumed == null) throw new Error(`Unknown bootstrap propose argument: ${args[index]}`);
      index = consumed;
    }
  }
  const parsed = readJsonFile(options.proposalFile, 'bootstrap proposal');
  const predictions = Array.isArray(parsed) ? parsed : parsed?.predictions;
  if (!Array.isArray(predictions)) {
    throw new Error('bootstrap proposal JSON must be an array or an object with a predictions array');
  }
  return { scanId, predictions, proposalFile: options.proposalFile, caller: callerFromOptions(options) };
}

function parseBootstrapRecommend(args) {
  const scanId = args[0];
  if (!scanId || scanId.startsWith('--')) throw new Error('bootstrap recommend requires a scan_id');
  let profileId = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--profile' && args[index + 1] !== undefined) profileId = args[++index];
    else throw new Error(`Unknown bootstrap recommend argument: ${args[index]}`);
  }
  return { scanId, profileId };
}

function parseBootstrapAdopt(args) {
  const scanId = args[0];
  if (!scanId || scanId.startsWith('--')) throw new Error('bootstrap adopt requires a scan_id');
  let contractId = null;
  let profileId = null;
  let reason = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--contract' && args[index + 1] !== undefined) contractId = args[++index];
    else if (args[index] === '--profile' && args[index + 1] !== undefined) profileId = args[++index];
    else if (args[index] === '--reason' && args[index + 1] !== undefined) reason = args[++index];
    else throw new Error(`Unknown bootstrap adopt argument: ${args[index]}`);
  }
  if (!contractId || !reason) {
    throw new Error('bootstrap adopt requires --contract <contract_id> and --reason <text>');
  }
  return { scanId, contractId, profileId, reason };
}

function printBootstrapShow(detail) {
  console.log(`Scan: ${detail.scan.id}`);
  console.log(`Status: ${detail.scan.status}`);
  console.log(`Root: ${detail.scan.root_path}`);
  console.log(`Fingerprint: ${detail.scan.fingerprint}`);
  console.log(`Files: ${detail.summary.files}; Markdown: ${detail.summary.markdown_files}; Directories: ${detail.summary.directories}`);
  console.log(`Predictions: ${detail.predictions.length}`);
  for (const prediction of detail.predictions) {
    console.log(`  ${prediction.id} ${prediction.kind} [${prediction.review?.decision ?? 'unreviewed'}]`);
    console.log(`    ${prediction.summary}`);
  }
  if (detail.scan.output_dir) console.log(`Output: ${detail.scan.output_dir}`);
}

function handleBootstrap(bootstrap, storage, args) {
  const [action, ...rest] = args;
  if (action === 'profiles') {
    if (rest.length) throw new Error('bootstrap profiles does not accept arguments');
    const catalog = bootstrap.profiles();
    emit('bootstrap.profiles', catalog, (data) => console.log(JSON.stringify(data, null, 2)));
  } else if (action === 'scan') {
    const receipt = bootstrap.scan(parseBootstrapScan(rest));
    emit('bootstrap.scan', receipt, () => {
      console.log(`${receipt.reused ? 'Reused' : 'Scanned'} ${receipt.scan_id}: ${receipt.markdown_files} Markdown file(s), ${receipt.predictions} Prediction(s).`);
      console.log(`Mode: ${receipt.scan_mode}; content files read: ${receipt.content_files_read}.`);
      console.log(`Fingerprint: ${receipt.fingerprint}`);
    });
  } else if (action === 'status') {
    if (rest.length) throw new Error('bootstrap status does not accept arguments');
    const rows = bootstrap.status();
    emit('bootstrap.status', rows, () => {
      if (!rows.length) console.log('No Bootstrap scans.');
      else {
        console.log('SCAN_ID\tSTATUS\tSTARTED_AT\tROOT');
        for (const row of rows) console.log(`${row.id}\t${row.status}\t${row.started_at}\t${row.root_path}`);
      }
    });
  } else if (action === 'show') {
    const scanId = rest.find((item) => !item.startsWith('--'));
    if (!scanId) throw new Error('bootstrap show requires a scan_id');
    const detail = bootstrap.show(scanId);
    emit('bootstrap.show', detail, printBootstrapShow);
  } else if (action === 'context') {
    const { scanId, maxSamples } = parseBootstrapContext(rest);
    const context = bootstrap.context(scanId, { maxSamples });
    emit('bootstrap.context', context, (data) => console.log(JSON.stringify(data, null, 2)));
  } else if (action === 'propose') {
    const { scanId, predictions, proposalFile, caller } = parseBootstrapPropose(rest);
    const receipt = bootstrap.propose(scanId, { predictions, caller });
    storage.markCaptured(proposalFile, scanId);
    emit('bootstrap.propose', receipt, () => {
      console.log(`${receipt.reused ? 'Reused' : 'Recorded'} proposal ${receipt.proposal_id}: ${receipt.prediction_ids.length} Prediction(s).`);
    });
  } else if (action === 'recommend') {
    const { scanId, profileId } = parseBootstrapRecommend(rest);
    const receipt = bootstrap.recommend(scanId, { profileId });
    emit('bootstrap.recommend', receipt, () => {
      console.log(`Recommended ${receipt.profile_id} (${receipt.selection}); ${receipt.prediction_ids.length} review(s) required.`);
    });
  } else if (action === 'contract') {
    const { scanId, profileId } = parseBootstrapRecommend(rest);
    const contract = bootstrap.contract(scanId, { profileId });
    emit('bootstrap.contract', contract, () => {
      console.log(`${contract.contract_id}: ${contract.profile.name} (${contract.status}).`);
      console.log(`${contract.zones.length} zone(s), ${contract.questions.length} question(s), no source changes.`);
    });
  } else if (action === 'adopt') {
    const options = parseBootstrapAdopt(rest);
    const receipt = bootstrap.adoptContract(options.scanId, options);
    emit('bootstrap.adopt', receipt, () => {
      console.log(`Adopted ${receipt.contract_id}; initialized ${receipt.scan_id}.`);
    });
  } else if (action === 'review') {
    const { predictionId, decision, reason } = parseBootstrapReview(rest);
    const receipt = bootstrap.review(predictionId, { decision, reason });
    emit('bootstrap.review', receipt, () => console.log(`Reviewed ${receipt.prediction_id}: ${receipt.decision}.`));
  } else if (action === 'initialize') {
    if (rest.length !== 1) throw new Error('bootstrap initialize requires one scan_id');
    const receipt = bootstrap.initialize(rest[0]);
    emit('bootstrap.initialize', receipt, () => console.log(`Initialized ${receipt.scan_id}: ${receipt.output_dir}`));
  } else {
    throw new Error(`Unknown bootstrap action: ${action ?? '(missing)'}`);
  }
}

function parseRisk(args) {
  const options = { paths: [], recoveryAvailable: true };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--operation') options.operation = args[++index];
    else if (token === '--path') options.paths.push(args[++index]);
    else if (token === '--count') options.fileCount = Number(args[++index]);
    else if (token === '--importance') options.targetImportance = args[++index];
    else if (token === '--link-impact') options.linkImpact = Number(args[++index]);
    else if (token === '--confidence') options.predictionConfidence = Number(args[++index]);
    else if (token === '--rules') options.modifiesRules = true;
    else if (token === '--no-recovery') options.recoveryAvailable = false;
    else if (token === '--guarded') options.requestedMode = 'guarded';
    else throw new Error(`Unknown risk argument: ${token}`);
  }
  if (!options.operation || !options.paths.length) throw new Error('risk requires --operation and --path');
  if (options.fileCount == null) options.fileCount = options.paths.length;
  return options;
}

function handleProject(registry, args) {
  const [action, ...rest] = args;
  if (action === 'list') {
    if (rest.length) throw new Error('project list does not accept arguments');
    const projects = registry.list();
    emit('project.list', projects, () => {
      if (!projects.length) console.log('No registered Projects.');
      else {
        console.log('PROJECT_ID\tSTATUS\tPATH\tNAME');
        for (const project of projects) {
          console.log(`${project.id}\t${project.status}\t${project.current_path}\t${project.name}`);
        }
      }
    });
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('project show requires one project_id');
    const detail = registry.show(rest[0]);
    emit('project.show', detail, () => console.log(JSON.stringify(detail, null, 2)));
    return;
  }
  if (action === 'create') {
    const options = { aliases: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--name') options.name = rest[++index];
      else if (token === '--path') options.currentPath = rest[++index];
      else if (token === '--alias') options.aliases.push(rest[++index]);
      else if (token === '--parent') options.parentProjectId = rest[++index];
      else if (token === '--split-from') (options.splitFrom ??= []).push(rest[++index]);
      else throw new Error(`Unknown project create argument: ${token}`);
    }
    const receipt = registry.create(options);
    emit('project.create', receipt, () => console.log(`Created Project ${receipt.project_id}.`));
    return;
  }
  if (action === 'move') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project move requires a project_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--path') options.currentPath = rest[++index];
      else if (token === '--name') options.name = rest[++index];
      else if (token === '--alias') (options.aliases ??= []).push(rest[++index]);
      else if (token === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown project move argument: ${token}`);
    }
    if (!options.currentPath) throw new Error('project move requires --path');
    const receipt = registry.update(projectId, options);
    emit('project.move', receipt, () => console.log(`Updated Project ${projectId}.`));
    return;
  }
  if (action === 'evolve') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project evolve requires a project_id');
    const options = { aliases: [] };
    for (let index = 1; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--name') options.name = rest[++index];
      else if (token === '--alias') options.aliases.push(rest[++index]);
      else if (token === '--status') options.status = rest[++index];
      else if (token === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown project evolve argument: ${token}`);
    }
    const receipt = registry.evolve(projectId, options);
    emit('project.evolve', receipt, () => console.log(`Evolved Project ${projectId} without source changes.`));
    return;
  }
  if (action === 'merge') {
    const sources = [];
    let target = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--source') sources.push(rest[++index]);
      else if (rest[index] === '--into') target = rest[++index];
      else throw new Error(`Unknown project merge argument: ${rest[index]}`);
    }
    if (!sources.length || !target) throw new Error('project merge requires --source and --into');
    const receipt = registry.merge(sources, target);
    emit('project.merge', receipt, () => console.log(`Merged ${sources.join(', ')} into ${target}.`));
    return;
  }
  throw new Error(`Unknown project action: ${action ?? '(missing)'}`);
}

function handleRule(ledger, args) {
  const [action, ...rest] = args;
  if (action === 'list') {
    if (rest.length) throw new Error('rule list does not accept arguments');
    const rules = ledger.listRuleVersions();
    emit('rule.list', rules, () => {
      if (!rules.length) console.log('No RuleVersions recorded.');
      else {
        console.log('RULE_VERSION_ID\tVERSION\tNAME');
        for (const rule of rules) console.log(`${rule.id}\t${rule.version}\t${rule.name}`);
      }
    });
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('rule show requires one rule_version_id');
    const rule = ledger.getRuleVersion(rest[0]);
    emit('rule.show', rule, () => console.log(JSON.stringify(rule, null, 2)));
    return;
  }
  throw new Error(`Unknown rule action: ${action ?? '(missing)'}`);
}

function parseReason(rest, start = 1) {
  let reason = null;
  for (let index = start; index < rest.length; index += 1) {
    if (rest[index] === '--reason' && rest[index + 1] !== undefined) reason = rest[++index];
    else throw new Error(`Unknown review argument: ${rest[index]}`);
  }
  return reason;
}

function printGuardedPreview(detail) {
  console.log(`Run: ${detail.run.id}`);
  console.log(`Status: ${detail.run.status}`);
  console.log(`Target: ${detail.candidate.target_path}`);
  console.log(`Risk: ${detail.risk.mode} — ${detail.risk.reason}`);
  console.log(`Candidate: sha256:${detail.candidate.content_hash}`);
  console.log('Recovery: baseline snapshot ready');
  console.log('Diff:');
  process.stdout.write(detail.candidate.diff_text);
}

function handleGuarded(guarded, args) {
  const [action, ...rest] = args;
  if (action === 'prepare') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--target') options.target = rest[++index];
      else if (token === '--candidate-file') options.candidateFile = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else if (token === '--importance') options.targetImportance = rest[++index];
      else if (token === '--link-impact') options.linkImpact = Number(rest[++index]);
      else if (token === '--confidence') options.predictionConfidence = Number(rest[++index]);
      else if (token === '--rules') options.modifiesRules = true;
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown guarded prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = guarded.prepare(options);
    emit('guarded.prepare', receipt, () => console.log(`Prepared ${receipt.run_id}: ${receipt.target}; approval required.`));
    return;
  }
  if (action === 'preview') {
    const runId = rest.find((value) => !value.startsWith('--'));
    if (!runId) throw new Error('guarded preview requires a run_id');
    const detail = guarded.preview(runId);
    emit('guarded.preview', detail, printGuardedPreview);
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error(`guarded ${action} requires a run_id`);
    const receipt = guarded[action](runId, { reason: parseReason(rest) });
    emit(`guarded.${action}`, receipt, () => console.log(`${action === 'approve' ? 'Approved' : 'Rejected'} ${receipt.run_id}.`));
    return;
  }
  if (action === 'revise') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('guarded revise requires a run_id');
    let candidateFile = null;
    let reason = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--candidate-file') candidateFile = rest[++index];
      else if (rest[index] === '--reason') reason = rest[++index];
      else throw new Error(`Unknown guarded revise argument: ${rest[index]}`);
    }
    if (!candidateFile) throw new Error('guarded revise requires --candidate-file');
    const receipt = guarded.revise(runId, { candidateFile, reason });
    emit('guarded.revise', receipt, () => console.log(`Revised ${runId} as ${receipt.run_id}; new approval required.`));
    return;
  }
  if (action === 'execute' || action === 'rollback') {
    if (rest.length !== 1) throw new Error(`guarded ${action} requires one run_id`);
    const receipt = guarded[action](rest[0]);
    emit(`guarded.${action}`, receipt, () => console.log(`${action === 'execute' ? 'Executed and verified' : 'Rolled back'} ${receipt.run_id}.`));
    return;
  }
  throw new Error(`Unknown guarded action: ${action ?? '(missing)'}`);
}

function printDerivedPreview(detail) {
  console.log(`Run: ${detail.run.id}`);
  console.log(`Status: ${detail.run.status}`);
  console.log(`Target: ${detail.candidate.target_path}`);
  console.log(`Project: ${detail.placement.project_id}`);
  console.log(`Role: ${detail.placement.role}`);
  console.log(`Inputs: ${detail.inputs.map((input) => input.path).join(', ')}`);
  console.log(`Placement: ${detail.placement_prediction.review?.decision ?? 'unreviewed'}`);
  console.log('Diff:');
  process.stdout.write(detail.candidate.diff_text);
}

function handleDerived(derived, args) {
  const [action, ...rest] = args;
  if (action === 'recommend') {
    const options = { inputs: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--input') options.inputs.push(rest[++index]);
      else if (token === '--role') options.role = rest[++index];
      else if (token === '--filename') options.filename = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else throw new Error(`Unknown derive recommend argument: ${token}`);
    }
    const recommendation = derived.recommend(options);
    emit('derive.recommend', recommendation, (data) => {
      console.log(`${data.status}: ${data.target ?? 'no target'} — ${data.reason}`);
    });
    return;
  }
  if (action === 'prepare') {
    const options = { inputs: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--input') options.inputs.push(rest[++index]);
      else if (token === '--target') options.target = rest[++index];
      else if (token === '--candidate-file') options.candidateFile = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--role') options.role = rest[++index];
      else if (token === '--relation') options.relationType = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else if (token === '--importance') options.targetImportance = rest[++index];
      else if (token === '--link-impact') options.linkImpact = Number(rest[++index]);
      else if (token === '--confidence') options.predictionConfidence = Number(rest[++index]);
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown derive prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = derived.prepare(options);
    emit('derive.prepare', receipt, () => {
      console.log(`Prepared ${receipt.run_id}: ${receipt.role} → ${receipt.target}; placement review required.`);
    });
    return;
  }
  if (action === 'preview') {
    if (rest.length !== 1) throw new Error('derive preview requires one run_id');
    emit('derive.preview', derived.preview(rest[0]), printDerivedPreview);
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error(`derive ${action} requires a run_id`);
    const receipt = derived[action](runId, { reason: parseReason(rest) });
    emit(`derive.${action}`, receipt, () => {
      console.log(`${action === 'approve' ? 'Approved' : 'Rejected'} placement for ${receipt.run_id}.`);
    });
    return;
  }
  if (action === 'revise') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('derive revise requires a run_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--target') options.target = rest[++index];
      else if (rest[index] === '--role') options.role = rest[++index];
      else if (rest[index] === '--candidate-file') options.candidateFile = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown derive revise argument: ${rest[index]}`);
    }
    if (!options.target && !options.role && !options.candidateFile) {
      throw new Error('derive revise requires --target, --role, or --candidate-file');
    }
    const receipt = derived.revise(runId, options);
    emit('derive.revise', receipt, () => console.log(`Revised ${runId} as ${receipt.run_id}; new placement review required.`));
    return;
  }
  if (action === 'promote') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('derive promote requires a run_id');
    let role = null;
    let reason = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--role') role = rest[++index];
      else if (rest[index] === '--reason') reason = rest[++index];
      else throw new Error(`Unknown derive promote argument: ${rest[index]}`);
    }
    if (!role) throw new Error('derive promote requires --role');
    const receipt = derived.promote(runId, { role, reason });
    emit('derive.promote', receipt, () => console.log(`Role ${receipt.from_role} → ${receipt.to_role}: ${receipt.path}`));
    return;
  }
  if (action === 'execute' || action === 'rollback') {
    if (rest.length !== 1) throw new Error(`derive ${action} requires one run_id`);
    const receipt = derived[action](rest[0]);
    emit(`derive.${action}`, receipt, () => {
      console.log(`${action === 'execute' ? 'Created and verified' : 'Rolled back'} ${receipt.run_id}.`);
    });
    return;
  }
  throw new Error(`Unknown derive action: ${action ?? '(missing)'}`);
}

function handleIntake(intake, args) {
  const [action, ...rest] = args;
  if (action === 'prepare') {
    const options = { inputs: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--candidate-file') options.candidateFile = rest[++index];
      else if (token === '--origin') options.origin = rest[++index];
      else if (token === '--kind') options.kind = rest[++index];
      else if (token === '--filename') options.filename = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--input') options.inputs.push(rest[++index]);
      else if (token === '--relation') options.relationType = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown intake prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = intake.prepare(options);
    emit('intake.prepare', receipt, (data) => {
      if (data.run_id) console.log(`Prepared ${data.run_id}: ${data.classification.kind} → ${data.target}.`);
      else console.log(`${data.status}: ${data.reason}`);
    });
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('intake show requires one run_id');
    emit('intake.show', intake.show(rest[0]), printDerivedPreview);
    return;
  }
  if (action === 'execute') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('intake execute requires a run_id');
    const receipt = intake.execute(runId, { reason: parseReason(rest) });
    emit('intake.execute', receipt, (data) => console.log(`Intake created and verified ${data.target}.`));
    return;
  }
  if (action === 'rollback') {
    if (rest.length !== 1) throw new Error('intake rollback requires one run_id');
    const receipt = intake.rollback(rest[0]);
    emit('intake.rollback', receipt, (data) => console.log(`Rolled back Intake ${data.run_id}.`));
    return;
  }
  throw new Error(`Unknown intake action: ${action ?? '(missing)'}`);
}

function handleEvolution(evolution, args) {
  const [action, ...rest] = args;
  if (action === 'prepare') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--operation') options.operation = rest[++index];
      else if (token === '--source') options.source = rest[++index];
      else if (token === '--target') options.target = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown evolve prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = evolution.prepare(options);
    emit('evolve.prepare', receipt, (data) => {
      console.log(`Prepared ${data.run_id}: ${data.operation} → ${data.target}.`);
    });
    return;
  }
  if (action === 'preview') {
    if (rest.length !== 1) throw new Error('evolve preview requires one run_id');
    const detail = evolution.preview(rest[0]);
    emit('evolve.preview', detail, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error(`evolve ${action} requires a run_id`);
    const receipt = evolution[action](runId, { reason: parseReason(rest) });
    emit(`evolve.${action}`, receipt, (data) => console.log(`${action === 'approve' ? 'Approved' : 'Rejected'} ${data.run_id}.`));
    return;
  }
  if (action === 'execute' || action === 'rollback') {
    if (rest.length !== 1) throw new Error(`evolve ${action} requires one run_id`);
    const receipt = evolution[action](rest[0]);
    emit(`evolve.${action}`, receipt, (data) => {
      console.log(`${action === 'execute' ? 'Executed and verified' : 'Rolled back'} ${data.run_id}.`);
    });
    return;
  }
  throw new Error(`Unknown evolve action: ${action ?? '(missing)'}`);
}

function handleWork(storage, args) {
  const [action, ...rest] = args;
  if (action === 'stage') {
    const options = { ttlHours: 168 };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--file') options.source = rest[++index];
      else if (rest[index] === '--kind') options.kind = rest[++index];
      else if (rest[index] === '--ttl-hours') options.ttlHours = Number(rest[++index]);
      else throw new Error(`Unknown work stage argument: ${rest[index]}`);
    }
    const receipt = storage.stage(options);
    emit('work.stage', receipt, (data) => console.log(`Staged ${data.work_id}: ${data.payload_path}`));
    return;
  }
  if (action === 'status') {
    if (rest.length > 1) throw new Error('work status accepts at most one work_id');
    const data = rest[0] ? storage.showWork(rest[0]) : storage.listWork();
    emit('work.status', data, (value) => console.log(JSON.stringify(value, null, 2)));
    return;
  }
  if (action === 'release') {
    const workId = rest[0];
    if (!workId || workId.startsWith('--')) throw new Error('work release requires a work_id');
    const receipt = storage.release(workId, { reason: parseReason(rest) });
    emit('work.release', receipt, (data) => console.log(`Released ${data.work_id}; storage cleanup may remove it after the age gate.`));
    return;
  }
  throw new Error(`Unknown work action: ${action ?? '(missing)'}`);
}

function handleStorage(storage, args) {
  const [action, ...rest] = args;
  if (action === 'status') {
    if (rest.length) throw new Error('storage status does not accept arguments');
    const status = storage.status();
    emit('storage.status', status, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'plan' || action === 'execute') {
    const options = parseAgeOptions(rest, 168);
    const result = storage[action](options);
    emit(`storage.${action}`, result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown storage action: ${action ?? '(missing)'}`);
}

function handleTask(task, args) {
  const [action, ...rest] = args;
  if (action === 'prepare') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--request-file') options.requestFile = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown task prepare argument: ${token}`);
        index = consumed;
      }
    }
    if (!options.root || !options.requestFile) throw new Error('task prepare requires --root and --request-file');
    const request = readJsonFile(options.requestFile, 'task request');
    const receipt = task.prepare({ root: options.root, request, caller: callerFromOptions(options) });
    emit('task.prepare', receipt, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('task show requires one task_id');
    emit('task.show', task.show(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'fulfill') {
    const taskId = rest[0];
    if (!taskId || taskId.startsWith('--')) throw new Error('task fulfill requires a task_id');
    let candidateFile = null;
    let reason = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--candidate-file') candidateFile = rest[++index];
      else if (rest[index] === '--reason') reason = rest[++index];
      else throw new Error(`Unknown task fulfill argument: ${rest[index]}`);
    }
    if (!candidateFile) throw new Error('task fulfill requires --candidate-file');
    const receipt = task.fulfill(taskId, { candidateFile, reason });
    emit('task.fulfill', receipt, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'complete') {
    const taskId = rest[0];
    if (!taskId || taskId.startsWith('--')) throw new Error('task complete requires a task_id');
    let runId = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--run') runId = rest[++index];
      else throw new Error(`Unknown task complete argument: ${rest[index]}`);
    }
    if (!runId) throw new Error('task complete requires --run');
    emit('task.complete', task.complete(taskId, { runId }), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'rollback') {
    if (rest.length !== 1) throw new Error('task rollback requires one task_id');
    emit('task.rollback', task.rollback(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown task action: ${action ?? '(missing)'}`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  outputJson = rawArgs.includes('--json');
  const [command, ...args] = rawArgs.filter((item) => item !== '--json');
  activeCommand = command ?? 'help';
  if (!command || command === '--help' || command === '-h') {
    emit('help', { usage: usage() }, ({ usage: helpText }) => console.log(helpText));
    return;
  }
  if (command === 'version') {
    if (args.length) throw new Error('version does not accept arguments');
    emit('version', { version: ATLAS_VERSION }, ({ version }) => console.log(`Atlas ${version}`));
    return;
  }
  if (command === 'capabilities') {
    if (args.length) throw new Error('capabilities does not accept arguments');
    emit('capabilities', CAPABILITIES, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  stateDir = normalizeStateDir(projectRoot, stateDirInput);

  const tracker = new Tracker({ stateDir });
  const bootstrap = new Bootstrap({ stateDir });
  const guarded = new Guarded({ stateDir });
  const derived = new Derived({ stateDir });
  const evolution = new Evolution({ stateDir });
  const intake = new Intake({ stateDir });
  const registry = new Registry({ stateDir });
  const storage = new RuntimeStorage({ stateDir, ledger: tracker.ledger });
  const task = new TaskContract({ stateDir });
  try {
    if (command === 'doctor') {
      if (args.length) throw new Error('doctor does not accept arguments');
      const ledger = tracker.ledger.diagnostics();
      const data = {
        status: ledger.integrity === 'ok' && ledger.schema_version === ledger.supported_schema_version
          ? 'ok'
          : 'failed',
        node: { version: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 24 },
        project_root: projectRoot,
        state_dir: stateDir,
        state_inside_project: true,
        ledger,
      };
      emit('doctor', data, (detail) => {
        console.log(`Atlas doctor: ${detail.status}`);
        console.log(`Node: ${detail.node.version} (${detail.node.supported ? 'supported' : 'unsupported'})`);
        console.log(`Ledger: schema ${detail.ledger.schema_version}; integrity ${detail.ledger.integrity}`);
        console.log(`State: ${detail.state_dir}`);
      });
      if (data.status !== 'ok' || !data.node.supported) process.exitCode = 1;
    } else if (command === 'bootstrap') {
      handleBootstrap(bootstrap, storage, args);
    } else if (command === 'guarded') {
      handleGuarded(guarded, args);
    } else if (command === 'derive') {
      handleDerived(derived, args);
    } else if (command === 'intake') {
      handleIntake(intake, args);
    } else if (command === 'evolve') {
      handleEvolution(evolution, args);
    } else if (command === 'task') {
      handleTask(task, args);
    } else if (command === 'work') {
      handleWork(storage, args);
    } else if (command === 'storage') {
      handleStorage(storage, args);
    } else if (command === 'project') {
      handleProject(registry, args);
    } else if (command === 'rule') {
      handleRule(tracker.ledger, args);
    } else if (command === 'risk') {
      const result = evaluateRisk(parseRisk(args));
      emit('risk', result, () => console.log(JSON.stringify(result, null, 2)));
    } else if (command === 'begin') {
      const receipt = tracker.begin(parseBegin(args));
      emit('begin', receipt, printBegin);
    } else if (command === 'close') {
      if (args.length > 1) throw new Error('close accepts at most one run_id');
      const receipt = tracker.close(args[0] ?? null);
      emit('close', receipt, printClose);
      if (receipt.policy !== 'pass') process.exitCode = 2;
    } else if (command === 'abort') {
      const { runId, reason } = parseAbort(args);
      const receipt = tracker.abort(runId, { reason });
      emit('abort', receipt, () => console.log(`Aborted ${receipt.run_id}: ${receipt.reason}; released ${receipt.released_materials} material(s).`));
    } else if (command === 'status') {
      if (args.length) throw new Error('status does not accept arguments');
      const rows = tracker.status();
      emit('status', rows, printStatus);
    } else if (command === 'show') {
      const runId = args.find((arg) => !arg.startsWith('--'));
      if (!runId) throw new Error('show requires a run_id');
      const detail = tracker.show(runId);
      emit('show', detail, printShow);
    } else if (command === 'rollback') {
      if (args.length !== 1) throw new Error('rollback requires one run_id');
      const receipt = tracker.rollback(args[0]);
      emit('rollback', receipt, () => console.log(`Rolled back ${receipt.run_id}: restored ${receipt.restored_files} file(s).`));
    } else if (command === 'gc') {
      const result = tracker.gc(parseGc(args));
      emit('gc', result, () => console.log(`GC: deleted ${result.deleted_blobs} blob(s), ${result.deleted_bytes} byte(s); kept ${result.skipped_referenced} referenced and ${result.skipped_recent} recent.`));
    } else {
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
    }
  } finally {
    tracker.dispose();
    bootstrap.dispose();
    guarded.dispose();
    derived.dispose();
    evolution.dispose();
    intake.dispose();
    registry.dispose();
    task.dispose();
  }
}

main().catch((error) => {
  if (outputJson) console.log(JSON.stringify(errorEnvelope(activeCommand, error), null, 2));
  else console.error(`Atlas error: ${error.message}`);
  if (error instanceof RollbackConflictError) {
    if (!outputJson) {
      for (const conflict of error.conflicts) {
        console.error(`  conflict ${conflict.path}: expected ${conflict.expected_end_hash ?? 'absent'}, current ${conflict.current_hash ?? conflict.current_kind}`);
      }
    }
    process.exitCode = 3;
  } else {
    process.exitCode = 1;
  }
});
