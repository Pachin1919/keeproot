#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { BrowserCapture } from '../src/browser-capture.js';
import { exportAnalytics } from '../src/analytics-export.js';
import { Derived } from '../src/derived.js';
import { Evolution } from '../src/evolution.js';
import { Guarded } from '../src/guarded.js';
import { Intake } from '../src/intake.js';
import { WorkspaceInspector } from '../src/inspect.js';
import { Portfolio } from '../src/portfolio.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';
import { evaluateRisk } from '../src/risk.js';
import { isPathInside, normalizeStateDir } from '../src/paths.js';
import { RuntimeStorage } from '../src/runtime-storage.js';
import { withStateLock } from '../src/state-lock.js';
import { TaskContract } from '../src/task-contract.js';
import {
  ATLAS_VERSION,
  CAPABILITIES,
  callerFromOptions,
  errorEnvelope,
  successEnvelope,
} from '../src/protocol.js';
import { RollbackConflictError, Tracker } from '../src/tracker.js';
import { ledgerFileHash, listLedgerBackups, restoreLedgerBackup } from '../src/ledger-maintenance.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDirInput = process.env.ATLAS_STATE_DIR
  ? path.resolve(process.env.ATLAS_STATE_DIR)
  : path.join(projectRoot, '.atlas');
let stateDir = stateDirInput;
const installationRoot = process.env.ATLAS_HOME
  ? path.resolve(process.env.ATLAS_HOME)
  : projectRoot;
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
  atlas inspect --root <path> [--max-depth <1..8>]
  atlas ledger backups
  atlas ledger restore --backup <filename> --expect-current-hash <sha256>
  atlas analytics export [--name <export_name>]
  atlas begin --root <path> --allow <path> [--allow <path> ...] [--intent <text>]
              [--operation <type>] [--importance <level>] [--link-impact <count>] [--confidence <0..1>] [--rules]
  atlas close [run_id]
  atlas abort <run_id> [--reason <text>]
  atlas status [--limit <1..100>]
  atlas show <run_id> [--json]
  atlas rollback <run_id>
  atlas gc [--older-than-hours <number>]
  atlas storage status | plan | execute [--older-than-hours <number>]
  atlas capture localize --input-file <browser_capture.json|selected_text.txt> [--ttl-hours <number>]
  atlas capture sample <work_id> [--start-character <number>] [--characters <1..4000>]
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
  atlas portfolio inventory --root <path> [--depth <1|2>] [--expand <relative_directory> ...]
                            [--exclude <relative_path> ...] [--new]
  atlas portfolio show <inventory_id>
  atlas portfolio review <inventory_id> --root-id <root_id> --type <root_type>
                         --relation <relation> --reason <text>
  atlas portfolio plan <inventory_id> --target <path>
  atlas intake prepare --root <path> --candidate-file <path> --origin <origin>
                       [--kind <kind>] [--filename <name>] [--project <project_id>]
                       [--target <new_path>] [--input <related_path> ...] [--intent <text>]
  atlas intake show <run_id>
  atlas intake execute <run_id> --reason <task_authorization>
  atlas intake rollback <run_id>
  atlas intake correct --root <path> --scope <artifact|project|global> --origin <origin>
                       --kind <kind> --role <role> --target-subdirectory <path> --reason <text>
                       [--candidate-file <path>] [--project <project_id>]
  atlas intake batch-plan --root <path> --request-file <json>
  atlas intake corrections --root <path>
  atlas task prepare --root <path> --request-file <json> [agent options]
  atlas task discover --root <path> --project <project_id> [--role <role> ...]
                      [--extension <.ext> ...] [--modified-after <iso>] [--max-candidates <1..50>]
  atlas task show <task_id>
  atlas task fulfill <task_id> --candidate-file <path> [--reason <task_authorization>]
  atlas task archive-plan <task_id>
  atlas task complete <task_id> --run <derived_or_guarded_run_id>
  atlas task rollback <task_id>
  atlas evolve prepare --root <path> --operation <create_directory|move_file|migrate_project|migrate_directory|remove_empty_directory>
                       [--source <path>] --target <path> [--project <project_id>] [--intent <text>]
  atlas evolve preview <run_id>
  atlas evolve approve | reject <run_id> [--reason <text>]
  atlas evolve execute | rollback <run_id>
  atlas evolve plan-prepare --root <path> --request-file <json> [--intent <text>]
  atlas evolve plan-preview | plan-execute | plan-rollback <plan_run_id>
  atlas evolve plan-approve | plan-reject <plan_run_id> --reason <text>
  atlas risk --operation <type> --path <path> [--count <number>] [--rules] [--no-recovery]
  atlas rule list | show <rule_version_id>
  atlas rule active | history --root <path>
  atlas rule context --root <path> --request-file <json>
  atlas rule propose --root <path> --proposal-file <json> [agent options]
  atlas rule preview <rule_change_id>
  atlas rule approve | reject <rule_change_id> --reason <text>
  atlas project create --name <name> --path <relative_path> [--alias <name> ...]
  atlas project list | show <project_id> | evolve <project_id> [--name <name>] [--alias <name>] [--status <status>]
  atlas project move <project_id> --path <relative_path> [--name <name>]
  atlas guarded prepare --root <path> --target <path> --candidate-file <path> [--intent <text>]
  atlas guarded preview <run_id> [--json]
  atlas guarded approve | reject <run_id> [--reason <text>]
  atlas guarded apply-approved <run_id> --reason <user_approval>
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

function parseStatus(args) {
  let limit = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--limit' || args[index + 1] === undefined) {
      throw new Error(`Unknown status argument: ${args[index]}`);
    }
    limit = Number(args[++index]);
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error('status --limit must be an integer from 1 to 100');
  }
  return { limit };
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

function parseInspect(args) {
  const result = { maxDepth: 5 };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') result.root = args[++index];
    else if (args[index] === '--max-depth') result.maxDepth = Number(args[++index]);
    else throw new Error(`Unknown inspect argument: ${args[index]}`);
  }
  if (!result.root) throw new Error('inspect requires --root');
  return result;
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

function parsePortfolioInventory(args) {
  const result = { depth: 1, expand: [], exclude: [], forceNew: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') result.root = args[++index];
    else if (args[index] === '--depth') result.depth = Number(args[++index]);
    else if (args[index] === '--expand') result.expand.push(args[++index]);
    else if (args[index] === '--exclude') result.exclude.push(args[++index]);
    else if (args[index] === '--new') result.forceNew = true;
    else {
      const consumed = parseCallerFlag(result, args, index);
      if (consumed == null) throw new Error(`Unknown portfolio inventory argument: ${args[index]}`);
      index = consumed;
    }
  }
  if (!result.root || result.exclude.some((item) => item == null) || result.expand.some((item) => item == null)) {
    throw new Error('portfolio inventory requires --root; --expand and --exclude require values');
  }
  result.caller = callerFromOptions(result);
  return result;
}

function handlePortfolio(portfolio, args) {
  const [action, ...rest] = args;
  if (action === 'inventory') {
    const receipt = portfolio.inventory(parsePortfolioInventory(rest));
    emit('portfolio.inventory', receipt, () => {
      console.log(`${receipt.reused ? 'Reused' : 'Inventoried'} ${receipt.inventory_id}: ${receipt.root_candidates} root candidate(s).`);
      console.log(`Structure only: ${receipt.content_files_read} content file(s) read; truncated=${receipt.truncated}.`);
    });
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('portfolio show requires one inventory_id');
    const detail = portfolio.show(rest[0]);
    emit('portfolio.show', detail, () => console.log(JSON.stringify(detail, null, 2)));
    return;
  }
  if (action === 'review') {
    const inventoryId = rest[0];
    if (!inventoryId || inventoryId.startsWith('--')) throw new Error('portfolio review requires an inventory_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--root-id') options.rootId = rest[++index];
      else if (rest[index] === '--type') options.rootType = rest[++index];
      else if (rest[index] === '--relation') options.relation = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown portfolio review argument: ${rest[index]}`);
    }
    if (!options.rootId || !options.rootType || !options.relation || !options.reason) {
      throw new Error('portfolio review requires --root-id, --type, --relation, and --reason');
    }
    const receipt = portfolio.review(inventoryId, options);
    emit('portfolio.review', receipt, () => console.log(`Reviewed ${receipt.root_id}: ${receipt.root_type}, ${receipt.relation}.`));
    return;
  }
  if (action === 'plan') {
    const inventoryId = rest[0];
    if (!inventoryId || inventoryId.startsWith('--')) throw new Error('portfolio plan requires an inventory_id');
    let target = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--target') target = rest[++index];
      else throw new Error(`Unknown portfolio plan argument: ${rest[index]}`);
    }
    if (!target) throw new Error('portfolio plan requires --target <path>');
    const plan = portfolio.plan(inventoryId, { target });
    emit('portfolio.plan', plan, () => console.log(JSON.stringify(plan, null, 2)));
    return;
  }
  throw new Error(`Unknown portfolio action: ${action ?? '(missing)'}`);
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

function handleRule(rules, ledger, args) {
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
  if (action === 'active' || action === 'history') {
    if (rest.length !== 2 || rest[0] !== '--root') {
      throw new Error(`rule ${action} requires --root`);
    }
    const result = rules[action]({ root: rest[1] });
    emit(`rule.${action}`, result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'context') {
    let root = null;
    let requestFile = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--root') root = rest[++index];
      else if (rest[index] === '--request-file') requestFile = rest[++index];
      else throw new Error(`Unknown rule context argument: ${rest[index]}`);
    }
    if (!root || !requestFile) throw new Error('rule context requires --root and --request-file');
    const request = readJsonFile(requestFile, 'Effective rule context request');
    emit('rule.context', rules.context({ root, request }), (data) => {
      console.log(`${data.status}: ${data.applied_rules.length} active rule(s), ${data.gaps.length} gap(s).`);
    });
    return;
  }
  if (action === 'propose') {
    const options = {};
    let proposalFile = null;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--proposal-file') proposalFile = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown rule propose argument: ${token}`);
        index = consumed;
      }
    }
    if (!options.root || !proposalFile) throw new Error('rule propose requires --root and --proposal-file');
    options.proposal = readJsonFile(proposalFile, 'Preference rule proposal');
    options.caller = callerFromOptions(options);
    const result = rules.propose(options);
    emit('rule.propose', result, (data) => {
      console.log(`Prepared ${data.rule_change_id}; one rule review is required.`);
    });
    return;
  }
  if (action === 'preview') {
    if (rest.length !== 1) throw new Error('rule preview requires one rule_change_id');
    emit('rule.preview', rules.preview(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const changeId = rest[0];
    if (!changeId || changeId.startsWith('--')) throw new Error(`rule ${action} requires one rule_change_id`);
    const reason = parseReason(rest);
    const result = rules[action](changeId, { reason });
    emit(`rule.${action}`, result, (data) => {
      console.log(`${action === 'approve' ? 'Activated' : 'Rejected'} ${data.rule_id ?? data.rule_change_id}.`);
    });
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
  if (action === 'apply-approved') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('guarded apply-approved requires a run_id');
    const reason = parseReason(rest);
    if (!reason?.trim()) throw new Error('guarded apply-approved requires --reason');
    const started = process.hrtime.bigint();
    const receipt = guarded.applyApproved(runId, { reason });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const compact = {
      ...receipt,
      fast_path: true,
      elapsed_ms: Number(elapsedMs.toFixed(3)),
      within_10_second_budget: elapsedMs <= 10_000,
    };
    emit('guarded.apply-approved', compact, () => {
      console.log(`Approved, executed, and verified ${receipt.run_id} in ${compact.elapsed_ms} ms.`);
    });
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
      else if (token === '--target') options.target = rest[++index];
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
      else if (token === '--target') options.target = rest[++index];
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
  if (action === 'correct') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--scope') options.scope = rest[++index];
      else if (token === '--candidate-file') options.candidateFile = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--origin') options.origin = rest[++index];
      else if (token === '--kind') options.kind = rest[++index];
      else if (token === '--role') options.role = rest[++index];
      else if (token === '--target-subdirectory') options.targetSubdirectory = rest[++index];
      else if (token === '--reason') options.reason = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown intake correct argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = intake.correct(options);
    emit('intake.correct', receipt, (data) => {
      console.log(`Activated ${data.scope} routing correction ${data.rule_version_id}.`);
    });
    return;
  }
  if (action === 'batch-plan') {
    let root = null;
    let requestFile = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--root') root = rest[++index];
      else if (rest[index] === '--request-file') requestFile = rest[++index];
      else throw new Error(`Unknown intake batch-plan argument: ${rest[index]}`);
    }
    if (!root || !requestFile) throw new Error('intake batch-plan requires --root and --request-file');
    const request = readJsonFile(requestFile, 'Intake batch request');
    const result = intake.batchPlan({ root, items: request.items });
    emit('intake.batch-plan', result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'corrections') {
    if (rest.length !== 2 || rest[0] !== '--root') throw new Error('intake corrections requires --root');
    const result = intake.derived.ledger.listRoutingCorrections(rest[1]);
    emit('intake.corrections', result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown intake action: ${action ?? '(missing)'}`);
}

function handleEvolution(evolution, args) {
  const [action, ...rest] = args;
  if (action === 'plan-prepare') {
    const options = {};
    let requestFile = null;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--request-file') requestFile = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown evolve plan-prepare argument: ${token}`);
        index = consumed;
      }
    }
    if (!options.root || !requestFile) throw new Error('evolve plan-prepare requires --root and --request-file');
    const request = readJsonFile(requestFile, 'organization plan request');
    options.operations = request.operations;
    options.intent ??= request.intent;
    options.caller = callerFromOptions(options);
    const receipt = evolution.preparePlan(options);
    emit('evolve.plan-prepare', receipt, (data) => {
      console.log(`Prepared ${data.run_id}: ${data.operations.length} operation(s), one approval required.`);
    });
    return;
  }
  if (action === 'plan-preview') {
    if (rest.length !== 1) throw new Error('evolve plan-preview requires one plan_run_id');
    emit('evolve.plan-preview', evolution.previewPlan(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'plan-approve') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('evolve plan-approve requires a plan_run_id');
    const receipt = evolution.approvePlan(runId, { reason: parseReason(rest) });
    emit('evolve.plan-approve', receipt, (data) => console.log(`Approved organization plan ${data.run_id}.`));
    return;
  }
  if (action === 'plan-reject') {
    const runId = rest[0];
    if (!runId || runId.startsWith('--')) throw new Error('evolve plan-reject requires a plan_run_id');
    const receipt = evolution.rejectPlan(runId, { reason: parseReason(rest) });
    emit('evolve.plan-reject', receipt, (data) => console.log(`Rejected organization plan ${data.run_id}.`));
    return;
  }
  if (action === 'plan-execute' || action === 'plan-rollback') {
    if (rest.length !== 1) throw new Error(`evolve ${action} requires one plan_run_id`);
    const receipt = action === 'plan-execute'
      ? evolution.executePlan(rest[0])
      : evolution.rollbackPlan(rest[0]);
    emit(`evolve.${action}`, receipt, (data) => console.log(`${data.status}: ${data.run_id}.`));
    return;
  }
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
      console.log(`Prepared ${data.run_id}: ${data.operation} → ${data.target ?? data.source}.`);
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

function handleCapture(capture, args) {
  const [action, ...rest] = args;
  if (action === 'localize') {
    const options = { ttlHours: 168 };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--input-file') options.inputFile = rest[++index];
      else if (rest[index] === '--ttl-hours') options.ttlHours = Number(rest[++index]);
      else throw new Error(`Unknown capture localize argument: ${rest[index]}`);
    }
    if (!options.inputFile) throw new Error('capture localize requires --input-file');
    const receipt = capture.localize(options);
    emit('capture.localize', receipt, (data) => {
      console.log(`Localized ${data.work_id}: ${data.output_bytes} bytes; completeness ${data.completeness}.`);
    });
    return;
  }
  if (action === 'sample') {
    const workId = rest[0];
    if (!workId || workId.startsWith('--')) throw new Error('capture sample requires one work_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--start-character') options.startCharacter = Number(rest[++index]);
      else if (rest[index] === '--characters') options.characters = Number(rest[++index]);
      else throw new Error(`Unknown capture sample argument: ${rest[index]}`);
    }
    const sample = capture.sample(workId, options);
    emit('capture.sample', sample, (data) => console.log(data.excerpt));
    return;
  }
  throw new Error(`Unknown capture action: ${action ?? '(missing)'}`);
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
  if (action === 'discover') {
    const options = { roles: [], extensions: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--role') options.roles.push(rest[++index]);
      else if (token === '--extension') options.extensions.push(rest[++index]);
      else if (token === '--modified-after') options.modifiedAfter = rest[++index];
      else if (token === '--max-candidates') options.maxCandidates = Number(rest[++index]);
      else throw new Error(`Unknown task discover argument: ${token}`);
    }
    if (!options.root || !options.projectId) throw new Error('task discover requires --root and --project');
    const result = task.discover(options);
    emit('task.discover', result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
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
  if (action === 'archive-plan') {
    if (rest.length !== 1) throw new Error('task archive-plan requires one task_id');
    emit('task.archive-plan', task.archivePlan(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'rollback') {
    if (rest.length !== 1) throw new Error('task rollback requires one task_id');
    emit('task.rollback', task.rollback(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown task action: ${action ?? '(missing)'}`);
}

function handleLedgerMaintenance(args) {
  const [action, ...rest] = args;
  if (action === 'backups') {
    if (rest.length) throw new Error('ledger backups does not accept arguments');
    const result = {
      current_hash: ledgerFileHash(stateDir),
      backups: listLedgerBackups(stateDir),
    };
    emit('ledger.backups', result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'restore') {
    let backupName = null;
    let expectedCurrentHash = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--backup') backupName = rest[++index];
      else if (rest[index] === '--expect-current-hash') expectedCurrentHash = rest[++index];
      else throw new Error(`Unknown ledger restore argument: ${rest[index]}`);
    }
    if (!backupName || !expectedCurrentHash) {
      throw new Error('ledger restore requires --backup and --expect-current-hash');
    }
    const result = restoreLedgerBackup({ stateDir, backupName, expectedCurrentHash });
    emit('ledger.restore', result, (data) => {
      console.log(`Restored Ledger from ${data.restored_from}; safety backup ${data.safety_backup}.`);
      console.log(data.next_step);
    });
    return;
  }
  throw new Error(`Unknown ledger action: ${action ?? '(missing)'}`);
}

function parseAnalyticsExport(args) {
  const [action, ...rest] = args;
  if (action !== 'export') throw new Error(`Unknown analytics action: ${action ?? '(missing)'}`);
  let exportName = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--name') exportName = rest[++index];
    else throw new Error(`Unknown analytics export argument: ${rest[index]}`);
  }
  if (rest.includes('--name') && !exportName) {
    throw new Error('analytics export --name requires a value');
  }
  return { exportName };
}

function optionalPythonCapability() {
  const candidates = [
    process.env.ATLAS_PYTHON,
    path.join(installationRoot, 'python', 'venv', 'Scripts', 'python.exe'),
    path.join(installationRoot, 'python', 'venv', 'bin', 'python'),
  ].filter(Boolean).map((item) => path.resolve(item));
  const executable = candidates.find((item) => {
    try {
      return fs.lstatSync(item).isFile();
    } catch {
      return false;
    }
  }) ?? null;
  return {
    available: Boolean(executable),
    configured_path: executable,
    required_for_file_governance: false,
    input: 'analytics_export_directory_only',
  };
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
  if (command === 'inspect') {
    const detail = new WorkspaceInspector().inspect(parseInspect(args));
    emit('inspect', detail, (data) => {
      console.log(`Inspected ${data.root}: ${data.observed_entries} observed entries; ${data.issues.length} issue(s).`);
      console.log(`Read ${data.content_files_read} bounded control/reference file(s); no source changes.`);
    });
    return;
  }
  stateDir = normalizeStateDir(projectRoot, stateDirInput, installationRoot);

  if (command === 'ledger') {
    handleLedgerMaintenance(args);
    return;
  }

  const tracker = new Tracker({ stateDir });
  const bootstrap = new Bootstrap({ stateDir });
  const guarded = new Guarded({ stateDir });
  const derived = new Derived({ stateDir });
  const evolution = new Evolution({ stateDir });
  const intake = new Intake({ stateDir });
  const portfolio = new Portfolio({ stateDir });
  const registry = new Registry({ stateDir });
  const storage = new RuntimeStorage({ stateDir, ledger: tracker.ledger });
  const capture = new BrowserCapture({ stateDir, storage });
  const task = new TaskContract({ stateDir });
  const rules = new PreferenceRules({ stateDir, ledger: tracker.ledger });
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
        installation_root: installationRoot,
        state_inside_project: isPathInside(projectRoot, stateDir),
        state_inside_installation: isPathInside(installationRoot, stateDir),
        ledger,
        capabilities: {
          file_governance: true,
          analytics_export: true,
          analytics_python: optionalPythonCapability(),
        },
      };
      emit('doctor', data, (detail) => {
        console.log(`Atlas doctor: ${detail.status}`);
        console.log(`Node: ${detail.node.version} (${detail.node.supported ? 'supported' : 'unsupported'})`);
        console.log(`Ledger: schema ${detail.ledger.schema_version}; integrity ${detail.ledger.integrity}`);
        console.log(`State: ${detail.state_dir}`);
      });
      if (data.status !== 'ok' || !data.node.supported) process.exitCode = 1;
    } else if (command === 'analytics') {
      const options = parseAnalyticsExport(args);
      const result = withStateLock(stateDir, () => exportAnalytics({
        ledger: tracker.ledger,
        stateDir,
        exportName: options.exportName,
      }));
      emit('analytics.export', result, (detail) => {
        console.log(`Exported ${detail.record_count} analytics record(s) to ${detail.output_dir}.`);
      });
    } else if (command === 'bootstrap') {
      handleBootstrap(bootstrap, storage, args);
    } else if (command === 'portfolio') {
      handlePortfolio(portfolio, args);
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
    } else if (command === 'capture') {
      handleCapture(capture, args);
    } else if (command === 'storage') {
      handleStorage(storage, args);
    } else if (command === 'project') {
      handleProject(registry, args);
    } else if (command === 'rule') {
      handleRule(rules, tracker.ledger, args);
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
      const rows = tracker.status(parseStatus(args));
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
    portfolio.dispose();
    registry.dispose();
    task.dispose();
    rules.dispose();
    capture.dispose();
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
