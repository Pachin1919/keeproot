#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { BrowserCapture } from '../src/browser-capture.js';
import { Catalog } from '../src/catalog.js';
import {
  compareContent,
  compareContentBranches,
  contentFileFingerprint,
  inspectContent,
} from '../src/content-inspection.js';
import { prepareDataWorkspace } from '../src/data-workspace.js';
import { compactContextPackReceipt, prepareContextPack } from '../src/context-pack.js';
import { prepareConversationSave } from '../src/conversation-localization.js';
import { Derived } from '../src/derived.js';
import { Evolution } from '../src/evolution.js';
import { Guarded } from '../src/guarded.js';
import { Intake } from '../src/intake.js';
import { SaveService } from '../src/save-service.js';
import { createResourceControl } from '../src/resource-control.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { createBoardService } from '../src/board-service.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { WorkspaceInspector } from '../src/inspect.js';
import { Portfolio } from '../src/portfolio.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';
import { evaluateRisk } from '../src/risk.js';
import { isPathInside, normalizeStateDir } from '../src/paths.js';
import { RuntimeStorage } from '../src/runtime-storage.js';
import {
  doctorDesktopUiComponent,
  installDesktopUiComponent,
  removeDesktopUiComponent,
  startDesktopUi,
} from '../src/desktop-ui-component.js';
import { openLocalUi } from '../src/ui-launcher.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { buildResourceImpactLanes } from '../src/ui/services/resource-impact-service.js';
import { createSavedWorkService, savedResultFreshness, sourceVersionPolicy } from '../src/ui/services/saved-work-service.js';
import {
  ATLAS_VERSION,
  CAPABILITIES,
  callerFromOptions,
  errorEnvelope,
  successEnvelope,
} from '../src/protocol.js';
import { RollbackConflictError, Tracker } from '../src/tracker.js';
import { ledgerFileHash, listLedgerBackups, restoreLedgerBackup } from '../src/ledger-maintenance.js';
import {
  inspectionResultSummary,
  recordInspectionWork,
} from '../src/work-coordination.js';
import {
  beginCurrentActivity,
  failCurrentActivity,
  finishCurrentActivity,
} from '../src/ui/current-activity.js';

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

function isUnboundInstalledRuntime() {
  if (process.env.ATLAS_STATE_DIR) return false;
  const manifestPath = path.join(path.dirname(projectRoot), 'atlas-install.json');
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.install_format === 'atlas-runtime-install.v1'
      && path.resolve(manifest.runtime_path ?? '') === projectRoot;
  } catch {
    return false;
  }
}

function isInstalledProductRuntime() {
  return path.resolve(installationRoot) !== projectRoot;
}

function exposedCapabilities() {
  if (!isInstalledProductRuntime()) return CAPABILITIES;
  const exposed = structuredClone(CAPABILITIES);
  delete exposed.workflows.guarded;
  delete exposed.workflows.derived;
  delete exposed.workflows.intake;
  exposed.product_entrypoints.internal_foundation.commands = [
    'bootstrap', 'tracked_direct', 'evolution',
  ];
  delete exposed.guarded_operations;
  delete exposed.guarded_review;
  delete exposed.derived_operations;
  delete exposed.derived_relation_types;
  delete exposed.intake_origins;
  delete exposed.intake_placement_modes;
  return exposed;
}

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

function foundationUsage() {
  return `Atlas ${ATLAS_VERSION} — local-first file governance foundation

Usage:
  atlas version [--json]
  atlas capabilities [--json]
  Current product: atlas ui; atlas view; atlas table-work; atlas board; atlas save prepare/show/execute/undo/redo
  Experimental recovery: atlas round list/show/protect/extend/checkpoint/restore/return/resume
  Other commands are supporting foundation or diagnostics.
  atlas doctor [ui] [--json]
  atlas inspect --root <path> [--max-depth <1..8>]
  atlas ledger backups
  atlas ledger restore --backup <filename> --expect-current-hash <sha256>
  atlas begin --root <path> --allow <path> [--allow <path> ...] [--intent <text>]
              [--operation <type>] [--importance <level>] [--link-impact <count>] [--confidence <0..1>] [--rules]
  atlas close [run_id]
  atlas abort <run_id> [--reason <text>]
  atlas status [--limit <1..100>]
  atlas show <run_id> [--compact] [--json]
  atlas rollback <run_id>
  atlas gc [--older-than-hours <number>]
  atlas storage status | plan | execute [--older-than-hours <number>]
  atlas capture fetch --url <public_http_url> [--ttl-hours <number>]
  atlas capture localize --input-file <browser_capture.json|selected_text.txt> [--ttl-hours <number>]
  atlas capture sample <work_id> [--start-character <number>] [--characters <1..4000>]
  atlas content inspect --file <path> [--purpose <structure|content|data|visual>]
                        [--sheet <xlsx_sheet_name>]
                        [--max-characters <500..20000>]
                        [--project <project_id>]
                        [--compact]
                        [--actor <actor>] [--agent <name>] [--model <name>]
                        [--tool <name>] [--client-run-id <id>]
  atlas resource relationships submit --request-file <json> --tool <name> --client-run-id <id>
  atlas resource show <resource_id> --project <project_id>
  atlas board list --project <project_id>
  atlas board create --project <project_id> --title <title>
  atlas board show <board_id> --project <project_id>
  atlas board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>
  atlas board export <board_id> --project <project_id> --base-revision <revision> --target <folder/file.html> --request-key <key> --tool <tool> --client-run-id <id>
  atlas view list --project <project_id>
  atlas view properties --project <project_id>
  atlas view save --project <project_id> --request-file <view.json> --tool <host> --client-run-id <id>
  atlas view candidates show <batch_id> --project <project_id>
  atlas view evaluate <view_id> [--limit <1..250>] [--continuation <opaque_token>]
  atlas view files --project <project_id> --scope <relative_folder_or_.> [--extension <ext> ...]
                   [--no-recursive] [--limit <1..250>] [--continuation <opaque_token>]
  atlas view candidates submit --project <project_id> --request-file <json>
                               --tool <name> --model <name> --client-run-id <id>
  atlas table-work start --project <project_id> --source <path> [--source <path> ...]
                         [--intent <work_goal>]
  atlas table-work list --project <project_id> [--limit <1..100>] [--offset <number>]
  atlas table-work show <session_id>
  atlas table-work reuse <session_id> --base-revision <revision> --request-file <assignments.json> --tool <tool> --client-run-id <id> [--intent <text>]
  atlas table-work reconcile <session_id> --source-key <source_key>
                             --decision <use-current|pin-recorded|follow-latest|stop-using>
                             --base-revision <revision> --tool <tool> --client-run-id <id>
  atlas table-work reconcile-batch <session_id> --request-file <source-keys.json>
                                   --decision <use-current|pin-recorded|follow-latest|stop-using>
                                   --base-revision <revision> --tool <tool> --client-run-id <id>
  atlas table-work add-source <session_id> --source <path> --base-revision <revision>
  atlas table-work remove-source <session_id> --resource <resource_id> --base-revision <revision>
  atlas table-work prepare <session_id> --base-revision <revision>
  atlas table-work sheet <session_id> --source-key <source_key> --sheet <sheet_name> --base-revision <revision>
  atlas table-work align <session_id> --request-file <mapping.json> --base-revision <revision>
  atlas table-work recipe <session_id> --request-file <recipe.json> --base-revision <revision>
  atlas table-work preview <session_id> --base-revision <revision>
  atlas table-work save <session_id> --folder <existing_relative_folder> --file-name <new.csv|new.xlsx>
                        --format <csv|xlsx> --base-revision <revision> --request-key <key> --reason <authorization>
                        --tool <name> --client-run-id <id>
  atlas content prepare-data --file <csv|tsv|xlsx> [--sheet <xlsx_sheet_name>]
  atlas content prepare-context --file <csv|tsv|xlsx> [--sheet <name>] --purpose <text> --include-column <exact_name> [...]
  atlas content compare --left <path> --right <path>
  atlas content branches --file <jsonl_path> --file <jsonl_path> [--file <jsonl_path> ...]
  atlas content localize-conversation --input <selection.json> --project <project_id>
                                      --request-key <key> --tool <host> --client-run-id <id>
                                      --output-relative <new_file.md>
                                      --actor <actor> --agent <name> --model <name>
                                      --tool <name> --client-run-id <id>
  atlas work stage --file <path> --kind <candidate|proposal|intermediate> [--ttl-hours <number>]
  atlas work status [work_id] | release <work_id> [--reason <text>]
  atlas save prepare --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                     --channel <host|import|work> --request-key <key> --tool <tool> --client-run-id <id>
  atlas save show <save_id> | execute <save_id> --reason <text> | undo <save_id> | redo <save_id>
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
  atlas root adopt --path <path> --type <root_type>
                   --content-policy <structure_only|bounded_content>
  atlas root list | show <root_id>
  atlas root relocate <root_id> --path <new_path> --reason <text>
  atlas root release <root_id> --reason <text>
  atlas project resolve --path <current_directory>
  atlas ui [--path <current_directory>] [--port <port>] [--no-open|--browser]
  atlas ui install --python <python-3.11-or-newer>
  atlas ui doctor | remove
  atlas catalog update --project <project_id> [agent options]
  atlas catalog search --project <project_id> [--term <text> ...]
                       [--extension <.ext> ...] [--max-candidates <1..50>]
  atlas intake prepare --root <path> --candidate-file <path> --origin <origin>
                       [--kind <kind>] [--filename <name>] [--project <project_id>]
                       [--target <new_path>] [--input <related_path> ...] [--intent <text>]
  atlas intake show <run_id>
  atlas intake correct --root <path> --scope <artifact|project|global> --origin <origin>
                       --kind <kind> --role <role> --target-subdirectory <path> --reason <text>
                       [--candidate-file <path>] [--project <project_id>]
  atlas intake batch-plan --root <path> --request-file <json>
  atlas intake corrections --root <path>
  atlas evolve prepare --root <path> [--target-root <path>] --operation <create_directory|move_file|migrate_project|migrate_directory|migrate_cross_root|remove_empty_directory>
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
  atlas project attach-root <project_id> --root <root_id> [--path <relative_path>] --reason <text>
  atlas project relocate <project_id> --root <root_id> --path <relative_path> --reason <text>
  atlas project link-context <target_project_id> --source <source_project_id>
                             --purpose <identifier> [--extension <.ext> ...]
                             [--max-candidates <1..50>] --reason <text>
  atlas project context-links <project_id> [--history]
  atlas project unlink-context <link_id> --reason <text>
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

function usage() {
  return `Atlas ${ATLAS_VERSION} — local Workspace and verified result saving

Current product:
  atlas ui [--path <current_directory>] [--port <port>] [--no-open|--browser]
  atlas ui install --python <python-3.11-or-newer>
  atlas ui doctor | remove
  atlas save prepare --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                     [--input <related_path> ...] --channel <host|import|work>
                     --request-key <key> --tool <tool> --client-run-id <id>
  atlas save show <save_id>
  atlas save execute <save_id> --reason <text>
  atlas save undo <save_id>
  atlas save redo <save_id>

  atlas table-work start --project <project_id> --source <path> [--source <path> ...]
                         [--intent <work_goal>]
  atlas table-work list --project <project_id> [--limit <1..100>] [--offset <number>]
  atlas table-work show <session_id>
  atlas table-work reuse <session_id> --base-revision <revision> --request-file <assignments.json> --tool <tool> --client-run-id <id> [--intent <text>]
  atlas table-work reconcile <session_id> --source-key <source_key> --decision <use-current|pin-recorded|follow-latest|stop-using>
                             --base-revision <revision> --tool <tool> --client-run-id <id>
  atlas table-work reconcile-batch <session_id> --request-file <source-keys.json> --decision <use-current|pin-recorded|follow-latest|stop-using>
                                   --base-revision <revision> --tool <tool> --client-run-id <id>
  atlas table-work prepare|preview <session_id> --base-revision <revision>
  atlas table-work add-source <session_id> --source <path> --base-revision <revision>
  atlas table-work remove-source <session_id> --resource <resource_id> --base-revision <revision>
  atlas table-work sheet <session_id> --source-key <source_key> --sheet <sheet_name> --base-revision <revision>
  atlas table-work align|recipe <session_id> --request-file <json> --base-revision <revision>
  atlas table-work save <session_id> --folder <existing_folder> --file-name <new_name>
                        --format <csv|xlsx> --base-revision <revision> --request-key <key> --reason <authorization>
                         --tool <name> --client-run-id <id>

  atlas board list --project <project_id>
  atlas board create --project <project_id> --title <title>
  atlas board show <board_id> --project <project_id>
  atlas board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>
  atlas board export <board_id> --project <project_id> --base-revision <revision>
                     --target <existing_folder/new.html> --request-key <key> --tool <host> --client-run-id <id>

  atlas view list --project <project_id>
  atlas view properties --project <project_id>
  atlas view save --project <project_id> --request-file <view.json> --tool <host> --client-run-id <id>
  atlas view candidates show <batch_id> --project <project_id>
  atlas view evaluate <view_id> [--limit <1..250>] [--continuation <opaque_token>]
  atlas view files --project <project_id> --scope <relative_folder_or_.> [--extension <ext> ...]
                   [--no-recursive] [--limit <1..250>] [--continuation <opaque_token>]
  atlas view candidates submit --project <project_id> --request-file <json>
                               --tool <name> --model <name> --client-run-id <id>

Current lookup and inspection:
  atlas content localize-conversation --input <selection.json> --project <project_id>
                                     --output-relative <existing_folder/new.md> --request-key <key>
                                     --tool <host> --client-run-id <id>
  atlas project list | show <project_id> | resolve --path <current_directory>
  atlas content inspect --file <path> [--purpose <structure|content|data|visual>]
  atlas content compare --left <path> --right <path>
  atlas resource relationships submit --request-file <json> --tool <name> --client-run-id <id>
  atlas resource show <resource_id> --project <project_id>

Health and protocol:
  atlas version [--json]
  atlas capabilities [--json]
  atlas doctor [ui] [--json]

Internal foundations are not fallback product workflows. Source developers may use:
  atlas help foundation

Pass --json for the stable ${CAPABILITIES.protocol_version} envelope.
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

function handleRoot(registry, args) {
  const [action, ...rest] = args;
  if (action === 'list') {
    if (rest.length) throw new Error('root list does not accept arguments');
    const roots = registry.listRoots();
    emit('root.list', roots, () => {
      if (!roots.length) console.log('No adopted Workspace Roots.');
      else {
        console.log('ROOT_ID\tTYPE\tCONTENT_POLICY\tPATH');
        for (const root of roots) {
          console.log(`${root.id}\t${root.root_type}\t${root.content_policy}\t${root.current_path}`);
        }
      }
    });
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('root show requires one root_id');
    const detail = registry.showRoot(rest[0]);
    emit('root.show', detail, () => console.log(JSON.stringify(detail, null, 2)));
    return;
  }
  if (action === 'adopt') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--path') options.rootPath = rest[++index];
      else if (rest[index] === '--type') options.rootType = rest[++index];
      else if (rest[index] === '--content-policy') options.contentPolicy = rest[++index];
      else throw new Error(`Unknown root adopt argument: ${rest[index]}`);
    }
    if (!options.rootPath || !options.rootType || !options.contentPolicy) {
      throw new Error('root adopt requires --path, --type, and --content-policy');
    }
    const receipt = registry.adoptRoot(options);
    emit('root.adopt', receipt, () => console.log(`Adopted Workspace Root ${receipt.root_id}.`));
    return;
  }
  if (action === 'relocate') {
    const rootId = rest[0];
    if (!rootId || rootId.startsWith('--')) throw new Error('root relocate requires a root_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--path') options.rootPath = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown root relocate argument: ${rest[index]}`);
    }
    if (!options.rootPath || !options.reason?.trim()) {
      throw new Error('root relocate requires --path and --reason');
    }
    const receipt = registry.relocateRoot(rootId, options);
    emit('root.relocate', receipt, () => console.log(
      receipt.status === 'relocated'
        ? `Relocated Workspace Root ${receipt.root_id} to ${receipt.current_path}.`
        : `Rejected Workspace Root relocation: ${receipt.reason_code}.`,
    ));
    return;
  }
  if (action === 'release') {
    const rootId = rest[0];
    if (!rootId || rootId.startsWith('--')) throw new Error('root release requires a root_id');
    let reason = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--reason') reason = rest[++index];
      else throw new Error(`Unknown root release argument: ${rest[index]}`);
    }
    if (!reason?.trim()) throw new Error('root release requires --reason');
    const receipt = registry.releaseRoot(rootId, { reason });
    emit('root.release', receipt, () => console.log(`Released Workspace Root ${receipt.root_id}.`));
    return;
  }
  throw new Error(`Unknown root action: ${action ?? '(missing)'}`);
}

function handleCatalog(catalog, args) {
  const [action, ...rest] = args;
  if (action === 'update') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown catalog update argument: ${rest[index]}`);
        index = consumed;
      }
    }
    if (!options.projectId) throw new Error('catalog update requires --project');
    const receipt = catalog.update({
      projectId: options.projectId,
      caller: callerFromOptions(options),
    });
    emit('catalog.update', receipt, () => {
      console.log(`Cataloged ${receipt.observed_files} file(s); ${receipt.changed_files} changed; ${receipt.reused_files} reused.`);
    });
    return;
  }
  if (action === 'search') {
    const options = { terms: [], extensions: [] };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--term') options.terms.push(rest[++index]);
      else if (rest[index] === '--extension') options.extensions.push(rest[++index]);
      else if (rest[index] === '--max-candidates') options.maxCandidates = Number(rest[++index]);
      else throw new Error(`Unknown catalog search argument: ${rest[index]}`);
    }
    if (!options.projectId) throw new Error('catalog search requires --project');
    const result = catalog.search(options);
    emit('catalog.search', result, () => console.log(JSON.stringify(result, null, 2)));
    return;
  }
  throw new Error(`Unknown catalog action: ${action ?? '(missing)'}`);
}

function handleProject(registry, args) {
  const [action, ...rest] = args;
  if (action === 'resolve') {
    let currentPath = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--path') currentPath = rest[++index];
      else throw new Error(`Unknown project resolve argument: ${rest[index]}`);
    }
    if (!currentPath) throw new Error('project resolve requires --path');
    const result = registry.resolvePath(currentPath);
    emit('project.resolve', result, () => console.log(JSON.stringify(result, null, 2)));
    return;
  }
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
  if (action === 'attach-root') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project attach-root requires a project_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--root') options.rootId = rest[++index];
      else if (rest[index] === '--path') options.relativePath = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown project attach-root argument: ${rest[index]}`);
    }
    if (!options.rootId || !options.reason) {
      throw new Error('project attach-root requires --root and --reason');
    }
    const receipt = registry.attachRoot(projectId, options);
    emit('project.attach-root', receipt, () => {
      console.log(`Attached Project ${projectId} to ${receipt.root_id}:${receipt.relative_path}.`);
    });
    return;
  }
  if (action === 'relocate') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project relocate requires a project_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--root') options.rootId = rest[++index];
      else if (rest[index] === '--path') options.relativePath = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown project relocate argument: ${rest[index]}`);
    }
    if (!options.rootId || !options.relativePath || !options.reason) {
      throw new Error('project relocate requires --root, --path, and --reason');
    }
    const receipt = registry.relocate(projectId, options);
    emit('project.relocate', receipt, () => console.log(JSON.stringify(receipt, null, 2)));
    return;
  }
  if (action === 'link-context') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project link-context requires a target project_id');
    const options = { extensions: [] };
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--source') options.sourceProjectId = rest[++index];
      else if (rest[index] === '--purpose') options.purpose = rest[++index];
      else if (rest[index] === '--extension') options.extensions.push(rest[++index]);
      else if (rest[index] === '--max-candidates') options.maxCandidates = Number(rest[++index]);
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else throw new Error(`Unknown project link-context argument: ${rest[index]}`);
    }
    if (!options.sourceProjectId || !options.purpose || !options.reason) {
      throw new Error('project link-context requires --source, --purpose, and --reason');
    }
    const receipt = registry.linkContext(projectId, options);
    emit('project.link-context', receipt, () => {
      console.log(`Linked Project ${projectId} to context source ${receipt.source_project_id}.`);
    });
    return;
  }
  if (action === 'context-links') {
    const projectId = rest[0];
    if (!projectId || projectId.startsWith('--')) throw new Error('project context-links requires a project_id');
    const history = rest.slice(1).includes('--history');
    if (rest.slice(1).some((item) => item !== '--history')) {
      throw new Error('project context-links accepts only --history');
    }
    const links = history
      ? registry.contextLinkHistory(projectId)
      : registry.contextLinks(projectId);
    emit('project.context-links', links, () => console.log(JSON.stringify(links, null, 2)));
    return;
  }
  if (action === 'unlink-context') {
    const linkId = rest[0];
    if (!linkId || linkId.startsWith('--')) throw new Error('project unlink-context requires a link_id');
    let reason = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--reason') reason = rest[++index];
      else throw new Error(`Unknown project unlink-context argument: ${rest[index]}`);
    }
    if (!reason) throw new Error('project unlink-context requires --reason');
    const receipt = registry.disableContextLink(linkId, { reason });
    emit('project.unlink-context', receipt, () => console.log(`Disabled context link ${linkId}.`));
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

function handleProjectViews(service, args) {
  const [action, ...rest] = args;
  if (action === 'save') {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--request-file') options.requestFile = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown view save argument: ${rest[index]}`);
        index = consumed;
      }
    }
    if (!options.projectId || !options.requestFile || !options.tool || !options.clientRunId) throw new Error('view save requires --project, --request-file, --tool, and --client-run-id.');
    const request = readJsonFile(options.requestFile, 'Saved View');
    if (!request || Array.isArray(request) || typeof request !== 'object') throw new Error('Saved View request must be an object.');
    if (!request.config?.scope || typeof request.config.scope.path !== 'string') throw new Error('Host View save requires an explicit config.scope.path.');
    const result = service.saveView({ projectId: options.projectId, viewId: request.view_id ?? null, name: request.name, mode: request.mode, config: request.config, baseRevision: request.base_revision ?? null });
    emit('view.save', { ...result, desktop_href: `/projects/${encodeURIComponent(result.project_id)}/resources?view=${encodeURIComponent(result.view_id)}` }, (data) => console.log(`Saved ${data.name} (revision ${data.revision}).`));
    return;
  }
  if (action === 'properties') {
    if (rest.length !== 2 || rest[0] !== '--project' || !rest[1] || rest[1].startsWith('--')) throw new Error('view properties requires --project <project_id>.');
    emit('view.properties', { project_id: rest[1], properties: service.listProperties(rest[1]) }, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'candidates') {
    const subaction = rest.shift();
    if (subaction === 'show') {
      if (rest.length !== 3 || !rest[0] || rest[0].startsWith('--') || rest[1] !== '--project' || !rest[2] || rest[2].startsWith('--')) {
        throw new Error('view candidates show requires one batch_id and --project <project_id>.');
      }
      emit('view.candidates.show', service.propertyCandidateBatch({ batchId: rest[0], projectId: rest[2] }), (data) => console.log(JSON.stringify(data, null, 2)));
      return;
    }
    if (subaction !== 'submit') throw new Error('view candidates requires submit or show.');
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--request-file') options.requestFile = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown view candidates submit argument: ${rest[index]}`);
        index = consumed;
      }
    }
    if (!options.projectId || !options.requestFile || !options.tool || !options.model || !options.clientRunId) throw new Error('view candidates submit requires --project, --request-file, --tool, --model, and --client-run-id.');
    const request = readJsonFile(options.requestFile, 'Property suggestion Preview');
    const result = service.submitPropertyCandidates({
      projectId: options.projectId,
      viewId: request.scope?.view_id ?? null,
      resourceIds: request.scope?.resource_ids ?? [],
      propertyId: request.property?.property_id ?? null,
      property: request.property?.property_id ? null : request.property,
      candidates: request.candidates,
      caller: callerFromOptions(options),
    });
    emit('view.candidates.submit', result, (data) => console.log(`Stored ${data.candidates.length} Property suggestion${data.candidates.length === 1 ? '' : 's'} for user review.`));
    return;
  }
  if (action === 'list') {
    let projectId = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') projectId = rest[++index];
      else throw new Error(`Unknown view list argument: ${rest[index]}`);
    }
    if (!projectId) throw new Error('view list requires --project');
    emit('view.list', service.listViews(projectId), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'evaluate') {
    const viewId = rest[0];
    if (!viewId || viewId.startsWith('--')) throw new Error('view evaluate requires one view_id');
    let limit = 100; let continuation = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--limit') limit = Number(rest[++index]);
      else if (rest[index] === '--continuation') continuation = rest[++index];
      else throw new Error(`Unknown view evaluate argument: ${rest[index]}`);
    }
    emit('view.evaluate', service.evaluateView({ viewId, limit, continuation }), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'files') {
    let projectId = null; let scopePath = null; let recursive = true; let limit = 100; let continuation = null;
    const extensions = [];
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') projectId = rest[++index];
      else if (rest[index] === '--scope') scopePath = rest[++index];
      else if (rest[index] === '--extension') extensions.push(rest[++index]);
      else if (rest[index] === '--no-recursive') recursive = false;
      else if (rest[index] === '--limit') limit = Number(rest[++index]);
      else if (rest[index] === '--continuation') continuation = rest[++index];
      else throw new Error(`Unknown view files argument: ${rest[index]}`);
    }
    if (!projectId || scopePath == null) throw new Error('view files requires --project and an explicit --scope');
    if (scopePath === '.') scopePath = '';
    emit('view.files', service.listProjectFiles({ projectId, scope: { path: scopePath, recursive, extensions }, limit, continuation }), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown view action: ${action ?? '(missing)'}`);
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
    throw new Error('atlas intake execute is unsupported for user-facing saves. Use atlas save execute.');
  }
  if (action === 'rollback') {
    throw new Error('atlas intake rollback is unsupported for user-facing saves. Use atlas save undo.');
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
  if (action === 'batch-execute') {
    throw new Error('atlas intake batch-execute is unsupported for user-facing saves. Use atlas save prepare and execute per item.');
  }
  if (action === 'corrections') {
    if (rest.length !== 2 || rest[0] !== '--root') throw new Error('intake corrections requires --root');
    const result = intake.derived.ledger.listRoutingCorrections(rest[1]);
    emit('intake.corrections', result, (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  throw new Error(`Unknown intake action: ${action ?? '(missing)'}`);
}

function handleSave(save, args) {
  const [action, ...rest] = args;
  if (action === 'prepare') {
    const options = { inputs: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--root') options.root = rest[++index];
      else if (token === '--candidate-file') options.candidateFile = rest[++index];
      else if (token === '--origin') options.origin = rest[++index];
      else if (token === '--kind') options.kind = rest[++index];
      else if (token === '--project') options.projectId = rest[++index];
      else if (token === '--target') options.target = rest[++index];
      else if (token === '--input') options.inputs.push(rest[++index]);
      else if (token === '--relation') options.relationType = rest[++index];
      else if (token === '--intent') options.intent = rest[++index];
      else if (token === '--channel') options.channel = rest[++index];
      else if (token === '--request-key') options.requestKey = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown save prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    emit('save.prepare', save.prepare(options), (data) => console.log(`Prepared ${data.save_id}.`));
    return;
  }
  if (action === 'show') {
    if (rest.length !== 1) throw new Error('save show requires one save_id');
    emit('save.show', save.show(rest[0]), (data) => console.log(`${data.save_id}: ${data.status}.`));
    return;
  }
  if (action === 'execute') {
    const saveId = rest[0];
    if (!saveId || saveId.startsWith('--')) throw new Error('save execute requires one save_id');
    emit('save.execute', save.execute(saveId, { reason: parseReason(rest) }), (data) => console.log(`Saved ${data.save_id}.`));
    return;
  }
  if (action === 'undo') {
    if (rest.length !== 1) throw new Error('save undo requires one save_id');
    emit('save.undo', save.undo(rest[0]), (data) => console.log(`Undid ${data.save_id}.`));
    return;
  }
  if (action === 'redo') {
    if (rest.length !== 1) throw new Error('save redo requires one save_id');
    emit('save.redo', save.redo(rest[0]), (data) => console.log(`Redid ${data.save_id}.`));
    return;
  }
  throw new Error(`Unknown save action: ${action ?? '(missing)'}`);
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
      else if (token === '--target-root') options.targetRoot = rest[++index];
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

function parseTableWork(args) {
  const [action, ...rest] = args; const options = { action, positional: [], sources: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--project') options.projectId = rest[++index];
    else if (token === '--limit') options.limit = Number(rest[++index]);
    else if (token === '--offset') options.offset = Number(rest[++index]);
    else if (token === '--intent') options.intent = rest[++index];
    else if (token === '--source') options.sources.push(rest[++index]);
    else if (token === '--resource') options.resourceId = rest[++index];
    else if (token === '--source-key') options.sourceKey = rest[++index];
    else if (token === '--decision') options.decision = rest[++index];
    else if (token === '--sheet') options.sheet = rest[++index];
    else if (token === '--request-file') options.requestFile = rest[++index];
    else if (token === '--base-revision') options.baseRevision = Number(rest[++index]);
    else if (token === '--folder') options.folder = rest[++index];
    else if (token === '--file-name') options.fileName = rest[++index];
    else if (token === '--format') options.format = rest[++index];
    else if (token === '--request-key') options.requestKey = rest[++index];
    else if (token === '--reason') options.reason = rest[++index];
    else {
      const consumed = parseCallerFlag(options, rest, index);
      if (consumed != null) index = consumed;
      else if (token.startsWith('--')) throw new Error(`Unknown table-work argument: ${token}`);
      else options.positional.push(token);
    }
  }
  return options;
}

function tableWorkProject(registry, projectId) {
  const project = registry.list().find((item) => item.id === projectId && item.status === 'active');
  if (!project) throw new Error('Table Work requires one active Project id.');
  const location = registry.show(project.id).location;
  if (!location?.root_path || location.relative_path == null) throw new Error('The selected Project does not have an available local location.');
  const root = path.resolve(location.root_path, ...String(location.relative_path).split('/').filter(Boolean));
  return { project: { id: project.id, name: project.name }, root, workspaceRoot: path.resolve(location.root_path) };
}

async function handleTableWork(registry, saveService, args) {
  const options = parseTableWork(args); const action = options.action;
  if (!action) throw new Error('table-work requires an action.');
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const dataWork = createDataWorkService({ stateDir, projectRoot, installationRoot, resourceControl });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const sessionEntry = (sessionId) => {
    const initial = dataWork.session(sessionId);
    if (!initial) throw new Error('This Work Session is unavailable.');
    const entry = tableWorkProject(registry, initial.project_id);
    dataWork.projectSession(entry.project);
    return { entry, session: dataWork.session(sessionId) };
  };
  const sourcePath = (entry, input) => {
    const resolved = path.resolve(entry.root, String(input ?? ''));
    if (!input || !isPathInside(entry.root, resolved) || resolved === entry.root) throw new Error('Every Table Work Source must be a file inside the selected Project.');
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Every Table Work Source must be a regular non-linked file.');
    if (!['.csv', '.xlsx'].includes(path.extname(resolved).toLowerCase())) throw new Error('Table Work supports CSV and XLSX Sources.');
    return resolved;
  };
  const readRequest = () => {
    if (!options.requestFile) throw new Error(`table-work ${action} requires --request-file <json>.`);
    return JSON.parse(fs.readFileSync(path.resolve(options.requestFile), 'utf8'));
  };
  const requireBaseRevision = () => {
    if (!Number.isInteger(options.baseRevision) || options.baseRevision < 1) {
      const error = new Error(`table-work ${action} requires --base-revision <current_revision>.`);
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    return options.baseRevision;
  };
  try {
    if (action === 'list') {
      if (!options.projectId || options.positional.length) throw new Error('table-work list requires --project <project_id>.');
      const entry = tableWorkProject(registry, options.projectId);
      emit('table-work.list', dataWork.discoverProjectSessions(entry.project, { limit: options.limit, offset: options.offset }), (data) => console.log(JSON.stringify(data, null, 2)));
      return;
    }
    if (action === 'start') {
      if (!options.projectId || !options.sources.length || !options.tool || !options.clientRunId) throw new Error('table-work start requires --project, at least one --source, --tool, and --client-run-id.');
      const entry = tableWorkProject(registry, options.projectId); const sourcePaths = options.sources.map((input) => sourcePath(entry, input));
      const resourceIds = [];
      for (const resolved of sourcePaths) {
        const identified = resourceControl.identify({ filePath: resolved, project: entry.project });
        resourceIds.push(identified.resource_id);
      }
      const session = dataWork.createProjectSession(entry.project, { origin: { kind: 'host' } }, resourceIds, { intent: options.intent, caller: callerFromOptions(options) });
      emit('table-work.start', session, (value) => console.log(`Started ${value.session_id} with ${value.sources.length} Source(s).`)); return;
    }
    const sessionId = options.positional[0];
    if (!sessionId || options.positional.length !== 1) throw new Error(`table-work ${action} requires one session_id.`);
    const { entry } = sessionEntry(sessionId);
    if (action === 'show') {
      const shown = await dataWork.validateSources(sessionId);
      const latestResult = shown.latest_save_id ? savedWork.find(shown.latest_save_id) : null;
      emit('table-work.show', latestResult ? { ...shown, latest_result: { ...latestResult, freshness: savedResultFreshness(latestResult, { sourceFreshness: shown.freshness, versionPolicy: sourceVersionPolicy(shown.sources, latestResult.version_policy) }) } } : shown, (value) => console.log(`${value.session_id}: ${value.sources.length} Source(s), Recipe v${value.recipe.version}.`)); return;
    }
    if (action === 'reuse') {
      if (options.sources.length || !options.tool || !options.clientRunId) throw new Error('table-work reuse requires --tool and --client-run-id; use --request-file for current Source assignments.');
      let sourceAssignments = null;
      if (options.requestFile) {
        const request = readRequest(); const entries = Array.isArray(request) ? request : request.sources;
        if (!Array.isArray(entries)) throw new Error('table-work reuse request must contain a sources array.');
        sourceAssignments = entries.map((item) => {
          const identified = resourceControl.identify({ filePath: sourcePath(entry, item?.source), project: entry.project });
          return { source_key: item?.source_key, resource_id: identified.resource_id, sheet: item?.sheet ?? null };
        });
      }
      const reused = dataWork.reuseProjectSession(sessionId, { baseRevision: requireBaseRevision(), sourceAssignments, intent: options.intent, caller: callerFromOptions(options) });
      emit('table-work.reuse', reused, (value) => console.log(`Reused ${sessionId} as ${value.session_id}.`)); return;
    }
    if (action === 'reconcile') {
      const decisions = ['use-current', 'pin-recorded', 'follow-latest', 'stop-using'];
      if (!options.sourceKey || !decisions.includes(options.decision) || !options.tool || !options.clientRunId) {
        throw new Error('table-work reconcile requires --source-key, --decision <use-current|pin-recorded|follow-latest|stop-using>, --tool, and --client-run-id.');
      }
      const reconciled = await dataWork.reconcileSource(sessionId, options.sourceKey, options.decision, { baseRevision: requireBaseRevision(), caller: callerFromOptions(options) });
      emit('table-work.reconcile', reconciled, (value) => console.log(`Reconciled ${options.sourceKey} at Work revision ${value.revision}.`)); return;
    }
    if (action === 'reconcile-batch') {
      const decisions = ['use-current', 'pin-recorded', 'follow-latest', 'stop-using'];
      if (!options.requestFile || !decisions.includes(options.decision) || !options.tool || !options.clientRunId) {
        throw new Error('table-work reconcile-batch requires --request-file, --decision <use-current|pin-recorded|follow-latest|stop-using>, --tool, and --client-run-id.');
      }
      const request = readRequest();
      const sourceKeys = Array.isArray(request) ? request : request.source_keys;
      if (!Array.isArray(sourceKeys) || !sourceKeys.length || sourceKeys.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('table-work reconcile-batch request must contain a non-empty source_keys array.');
      }
      const reconciled = await dataWork.reconcileSources(sessionId, sourceKeys, options.decision, { baseRevision: requireBaseRevision(), caller: callerFromOptions(options) });
      emit('table-work.reconcile-batch', reconciled, (value) => console.log(`Reconciled ${sourceKeys.length} Sources at Work revision ${value.revision}.`)); return;
    }
    if (action === 'add-source') {
      if (options.sources.length !== 1) throw new Error('table-work add-source requires exactly one --source.');
      const identified = resourceControl.identify({ filePath: sourcePath(entry, options.sources[0]), project: entry.project });
      emit('table-work.add-source', dataWork.addSource(sessionId, identified.resource_id, { baseRevision: requireBaseRevision() }), (value) => console.log(`Added Source; ${value.sources.length} selected.`)); return;
    }
    if (action === 'remove-source') {
      if (!options.resourceId) throw new Error('table-work remove-source requires --resource <resource_id>.');
      emit('table-work.remove-source', dataWork.removeSource(sessionId, options.resourceId, { baseRevision: requireBaseRevision() }), (value) => console.log(`Removed Source; ${value.sources.length} selected.`)); return;
    }
    if (action === 'prepare') { emit('table-work.prepare', await dataWork.prepareSources(sessionId, { baseRevision: requireBaseRevision() }), (value) => console.log(`Prepared ${value.sources.length} Source(s).`)); return; }
    if (action === 'sheet') {
      if (!options.sourceKey || !options.sheet) throw new Error('table-work sheet requires --source-key and --sheet.');
      dataWork.selectSourceSheet(sessionId, options.sourceKey, options.sheet, { baseRevision: requireBaseRevision() });
      emit('table-work.sheet', await dataWork.prepareSources(sessionId), (value) => console.log(`Prepared Sheet for ${value.session_id}.`)); return;
    }
    if (action === 'align') {
      const request = readRequest(); const mapping = Array.isArray(request) ? request : request.mapping;
      emit('table-work.align', dataWork.confirmMapping(sessionId, mapping, { baseRevision: requireBaseRevision() }), (value) => console.log(`Confirmed ${value.mapping.length} field alignment(s).`)); return;
    }
    if (action === 'recipe') { emit('table-work.recipe', dataWork.updateRecipe(sessionId, readRequest(), { baseRevision: requireBaseRevision() }), (value) => console.log(`Saved Recipe v${value.recipe.version}.`)); return; }
    if (action === 'preview') { emit('table-work.preview', await dataWork.previewPersistent(sessionId, { baseRevision: requireBaseRevision() }), (value) => console.log(`Previewed Recipe v${value.recipe.version}.`)); return; }
    if (action === 'save') {
      if (!options.folder || !options.fileName || !['csv', 'xlsx'].includes(options.format) || !options.requestKey || !options.reason || !options.tool || !options.clientRunId) throw new Error('table-work save requires --folder, --file-name, --format <csv|xlsx>, --request-key, --reason, --tool, and --client-run-id.');
      const baseRevision = requireBaseRevision();
      const session = await dataWork.validateSources(sessionId);
      dataWork.assertRevision(sessionId, baseRevision);
      if (!session.preview || session.preview_revision !== session.revision) { const error = new Error('Preview the current Recipe before saving.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
      const extension = `.${options.format}`;
      const stage = await dataWork.stagePersistent(sessionId, extension, { baseRevision });
      const sources = session.sources.map((item) => ({ source_key: item.source_key, resource_id: item.resource_id, path: item.file_path, sheet: item.sheet, fingerprint: item.fingerprint, version_policy: item.version_policy ?? 'follow_latest' }));
      let record;
      try {
        dataWork.assertRevision(sessionId, baseRevision);
        record = savedWork.save({
          project: entry.project, projectRoot: entry.root, root: entry.workspaceRoot, folder: options.folder, fileName: options.fileName,
          stagedPath: stage.path, expectedCandidateHash: stage.staged.sha256, sourcePath: sources[0].path, sourceFingerprint: sources[0].fingerprint,
          sources, recipe: session.recipe,
          versionPolicy: sourceVersionPolicy(session.sources),
          outputExtension: extension, requestKey: options.requestKey, caller: callerFromOptions(options), channel: 'host',
          executionReason: options.reason,
          parameters: { work_session_id: sessionId, mapping: session.mapping, recipe_version: session.recipe.version },
          resultSummary: { ...stage.result.result_summary, validation: stage.result.validation, format: options.format.toUpperCase(), recipe_version: session.recipe.version },
        });
      } finally { dataWork.clearPersistentStage(sessionId); }
      dataWork.recordSave(sessionId, record.work_id);
      emit('table-work.save', record, (value) => console.log(`Saved and verified ${value.work_id}.`)); return;
    }
    throw new Error(`Unknown table-work action: ${action}.`);
  } finally { resourceControl.dispose(); }
}

async function handleBoard(registry, saveService, args) {
  const [action, ...rest] = args;
  const options = { positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--project') options.projectId = rest[++index];
    else if (token === '--title') options.title = rest[++index];
    else if (token === '--base-revision') options.baseRevision = Number(rest[++index]);
    else if (token === '--request-file') options.requestFile = rest[++index];
    else if (token === '--target') options.target = rest[++index];
    else if (token === '--request-key') options.requestKey = rest[++index];
    else {
      const consumed = parseCallerFlag(options, rest, index);
      if (consumed != null) index = consumed;
      else if (token.startsWith('--')) throw new Error(`Unknown board argument: ${token}`);
      else options.positional.push(token);
    }
  }
  if (!action) throw new Error('board requires an action.');
  const boards = createBoardService({ stateDir, registry, saveService, projectRoot, installationRoot });
  const boardId = options.positional[0];
  const requireProject = () => {
    if (!options.projectId) throw new Error(`board ${action} requires --project <project_id>.`);
    return options.projectId;
  };
  const requireBoard = () => {
    if (!boardId || options.positional.length !== 1) throw new Error(`board ${action} requires one board_id.`);
    return boardId;
  };
  const requireRevision = () => {
    if (!Number.isInteger(options.baseRevision) || options.baseRevision < 1) {
      const error = new Error('board requires --base-revision <current_revision>.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    return options.baseRevision;
  };
  try {
    if (action === 'list') {
      if (options.positional.length) throw new Error('board list does not accept a board_id.');
      const data = boards.listBoards(requireProject());
      emit('board.list', { project_id: options.projectId, boards: data }, (value) => console.log(`${value.boards.length} Board(s).`)); return;
    }
    if (action === 'create') {
      if (options.positional.length || !options.title) throw new Error('board create requires --project and --title.');
      const created = boards.createBoard({ projectId: requireProject(), title: options.title });
      emit('board.create', { ...created, desktop_href: `/projects/${encodeURIComponent(options.projectId)}/boards/${encodeURIComponent(created.board_id)}` }, (value) => console.log(`Created ${value.board_id}.`)); return;
    }
    if (action === 'show') {
      const shown = boards.showBoard(requireProject(), requireBoard());
      emit('board.show', shown, (value) => console.log(`${value.title}: ${value.blocks.length} Block(s), revision ${value.revision}.`)); return;
    }
    if (action === 'save') {
      requireBoard(); requireProject(); requireRevision();
      if (!options.requestFile) throw new Error('board save requires --request-file <board.json>.');
      const request = JSON.parse(fs.readFileSync(path.resolve(options.requestFile), 'utf8'));
      const saved = boards.saveBoard({ projectId: options.projectId, boardId, title: request.title, blocks: request.blocks, baseRevision: options.baseRevision });
      emit('board.save', { ...saved, desktop_href: `/projects/${encodeURIComponent(options.projectId)}/boards/${encodeURIComponent(boardId)}` }, (value) => console.log(`Saved ${value.board_id} revision ${value.revision}.`)); return;
    }
    if (action === 'export') {
      requireBoard(); requireProject(); requireRevision();
      if (!options.target || !options.requestKey || !options.tool || !options.clientRunId) throw new Error('board export requires --target, --request-key, --tool, and --client-run-id.');
      const prepared = await boards.preparePortableDelivery({ projectId: options.projectId, boardId, baseRevision: options.baseRevision, target: options.target, caller: callerFromOptions(options), requestKey: options.requestKey });
      emit('board.export', prepared, (value) => console.log(`Prepared portable delivery ${value.save_id}; review ${value.desktop_href}.`)); return;
    }
    throw new Error(`Unknown board action: ${action}.`);
  } finally { boards.dispose(); }
}

function handleRound(registry, args) {
  const [action, ...rest] = args;
  const service = new RoundRecovery({ stateDir, registry });
  let result;
  try {
    if (action === 'list' && rest.length === 2 && rest[0] === '--project') {
      result = { project_id: rest[1], rounds: service.list({ projectId: rest[1] }) };
    } else if (action === 'show' && rest.length === 3 && rest[1] === '--project') {
      result = service.show({ projectId: rest[2], roundId: rest[0] });
    } else if (['protect', 'extend', 'checkpoint', 'restore', 'return', 'resume'].includes(action)
        && rest.length === 2 && rest[0] === '--request-file') {
      const requestPath = path.resolve(rest[1]);
      if (fs.statSync(requestPath).size > 64 * 1024) throw new Error('Round request must be at most 64 KiB.');
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8').replace(/^\uFEFF/u, ''));
      result = service[action === 'return' ? 'returnToLatest' : action](request);
    } else {
      throw new Error('Use round list --project <id>; show <round_id> --project <id>; or protect/extend/checkpoint/restore/return/resume --request-file <json>.');
    }
    emit(`round.${action}`, result, (value) => console.log(JSON.stringify(value, null, 2)));
  } finally { service.dispose(); }
}

async function handleCapture(capture, args) {
  const [action, ...rest] = args;
  if (action === 'fetch') {
    const options = { ttlHours: 168 };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--url') options.url = rest[++index];
      else if (rest[index] === '--ttl-hours') options.ttlHours = Number(rest[++index]);
      else throw new Error(`Unknown capture fetch argument: ${rest[index]}`);
    }
    if (!options.url) throw new Error('capture fetch requires --url');
    const receipt = await capture.fetchPublic(options);
    emit('capture.fetch', receipt, (data) => {
      console.log(`Fetched ${data.work_id}: ${data.downloaded_bytes} network bytes, ${data.output_bytes} local bytes.`);
    });
    return;
  }
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

function compactRunDetail(detail) {
  return {
    compact: true,
    run: detail.run,
    scopes: detail.scopes,
    changes: detail.changes.map((change) => ({
      path: change.path,
      changeType: change.changeType,
      allowed: change.allowed,
      beforeKind: change.beforeKind,
      beforeHash: change.beforeHash,
      afterKind: change.afterKind,
      afterHash: change.afterHash,
    })),
    latest_decision: detail.decisions.at(-1) ?? null,
    receipt: detail.receipt,
    abort_receipt: detail.abort_receipt,
    rollback_receipt: detail.rollback_receipt,
    rollback_progress: detail.rollback_progress,
    change_set: detail.change_set ? {
      id: detail.change_set.id,
      status: detail.change_set.status,
      diff_hash: detail.change_set.diff_hash,
      summary: detail.change_set.summary,
      created_at: detail.change_set.created_at,
      closed_at: detail.change_set.closed_at,
    } : null,
  };
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

function parseContent(args) {
  const [action, ...rest] = args;
  if (action === 'inspect') {
    const options = {
      action,
      purpose: 'content',
      sheet: null,
      maxCharacters: 4000,
      callerProvided: false,
      compact: false,
    };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--file') options.filePath = rest[++index];
      else if (rest[index] === '--purpose') options.purpose = rest[++index];
      else if (rest[index] === '--sheet') options.sheet = rest[++index];
      else if (rest[index] === '--max-characters') options.maxCharacters = Number(rest[++index]);
      else if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--compact') options.compact = true;
      else {
        const callerIndex = parseCallerFlag(options, rest, index);
        if (callerIndex == null) throw new Error(`Unknown content inspect argument: ${rest[index]}`);
        options.callerProvided = true;
        index = callerIndex;
      }
    }
    if (!options.filePath) throw new Error('content inspect requires --file <path>');
    options.caller = callerFromOptions(options);
    return options;
  }
  if (action === 'compare') {
    const options = { action };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--left') options.leftPath = rest[++index];
      else if (rest[index] === '--right') options.rightPath = rest[++index];
      else throw new Error(`Unknown content compare argument: ${rest[index]}`);
    }
    if (!options.leftPath || !options.rightPath) {
      throw new Error('content compare requires --left <path> and --right <path>');
    }
    return options;
  }
  if (action === 'prepare-data') {
    const options = { action, sheet: null };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--file') options.filePath = rest[++index];
      else if (rest[index] === '--sheet') options.sheet = rest[++index];
      else throw new Error(`Unknown content prepare-data argument: ${rest[index]}`);
    }
    if (!options.filePath) throw new Error('content prepare-data requires --file <path>');
    return options;
  }
  if (action === 'prepare-context') {
    const options = { action, sheet: null, includeColumns: [] };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--file') options.filePath = rest[++index];
      else if (rest[index] === '--sheet') options.sheet = rest[++index];
      else if (rest[index] === '--purpose') options.purpose = rest[++index];
      else if (rest[index] === '--include-column') options.includeColumns.push(rest[++index]);
      else throw new Error(`Unknown content prepare-context argument: ${rest[index]}`);
    }
    if (!options.filePath || !options.purpose || !options.includeColumns.length) {
      throw new Error(
        'content prepare-context requires --file, --purpose, and one or more --include-column values',
      );
    }
    return options;
  }
  if (action === 'branches') {
    const options = { action, filePaths: [] };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--file') options.filePaths.push(rest[++index]);
      else throw new Error(`Unknown content branches argument: ${rest[index]}`);
    }
    if (options.filePaths.length < 2 || options.filePaths.length > 12) {
      throw new Error('content branches requires 2 to 12 --file <path> inputs');
    }
    return options;
  }
  if (action === 'localize-conversation') {
    const options = { action, callerProvided: false };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--input') options.inputPath = rest[++index];
      else if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--output-relative') options.outputRelative = rest[++index];
      else if (rest[index] === '--request-key') options.requestKey = rest[++index];
      else {
        const callerIndex = parseCallerFlag(options, rest, index);
        if (callerIndex == null) throw new Error(`Unknown content localize-conversation argument: ${rest[index]}`);
        options.callerProvided = true;
        index = callerIndex;
      }
    }
    if (!options.inputPath || !options.projectId || !options.outputRelative || !options.requestKey || !options.tool || !options.clientRunId) {
      throw new Error('content localize-conversation requires --input, --project, --output-relative, --request-key, --tool, and --client-run-id.');
    }
    options.caller = callerFromOptions(options);
    return options;
  }
  throw new Error(`Unknown content action: ${action ?? '(missing)'}`);
}

function activeProjectLocation(projectId) {
  const registry = new Registry({ stateDir });
  try {
    const project = registry.list().find((item) => item.id === projectId && item.status === 'active');
    if (!project) throw new Error('The command requires one active Project id.');
    const location = registry.show(project.id).location;
    if (!location?.root_path || location.relative_path == null) {
      throw new Error('The selected Project does not have an available local location.');
    }
    const root = path.resolve(location.root_path, ...location.relative_path.split('/').filter(Boolean));
    return { project: { id: project.id, name: project.name }, root };
  } finally {
    registry.dispose();
  }
}

function projectForHostInspection(projectId, filePath) {
  if (!projectId) return null;
  const location = activeProjectLocation(projectId);
  if (!isPathInside(location.root, path.resolve(filePath))) {
    throw new Error('The inspected file must remain inside the selected Project.');
  }
  return location.project;
}

function compactDataWorkspaceReceipt(result) {
  return {
    schema: result.schema,
    status: result.status,
    workspace_id: result.workspace_id,
    cache_hit: result.cache_hit,
    source: {
      name: result.source?.name,
      path: result.source?.path,
    },
    selection: result.selection,
    summary: result.summary,
    review_path: result.files?.review?.path ?? null,
    normalized_path: result.files?.normalized?.path ?? null,
    model_visible_body_bytes: result.attention?.model_visible_body_bytes ?? null,
    elapsed_ms: result.elapsed_ms,
    limitations: result.limitations,
  };
}

function compactContentInspection(result) {
  const extraction = result.extraction ?? {};
  const columns = Array.isArray(extraction.columns) ? extraction.columns : [];
  const typeCounts = {};
  for (const column of columns) {
    const type = column.inferred_type ?? column.kind ?? column.type ?? 'Unknown';
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  const limitations = extraction.limits ?? result.limitations ?? null;
  return {
    schema: result.schema,
    compact: true,
    inspection_id: result.inspection_id,
    cache_hit: result.cache_hit === true,
    source: {
      name: result.source?.name,
      path: result.source?.path,
      extension: result.source?.extension,
      bytes: result.source?.bytes,
      sha256: result.source?.sha256,
    },
    processor: result.processor ? { name: result.processor.name, version: result.processor.version } : null,
    summary: {
      ...inspectionResultSummary(result),
      kind: extraction.kind ?? null,
      duplicate_rows: Number.isFinite(extraction.duplicate_row_count) ? extraction.duplicate_row_count : null,
      type_counts: typeCounts,
    },
    quality_warnings: Array.isArray(extraction.quality_warnings) ? extraction.quality_warnings : [],
    limitations,
    model_visible_body_bytes: 0,
    coordination: result.coordination,
    next_action: result.next_action ?? null,
  };
}

function optionalPythonCapability() {
  const detail = doctorDesktopUiComponent({ installationRoot, runtimeRoot: projectRoot });
  return {
    available: detail.status === 'ready',
    ...detail,
    configured_path: detail.python_path ?? null,
    required_for_file_governance: false,
    input: 'one_exact_authorized_file',
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  outputJson = rawArgs.includes('--json');
  const [command, ...args] = rawArgs.filter((item) => item !== '--json');
  activeCommand = command ?? 'help';
  if (isUnboundInstalledRuntime()) {
    const error = new Error('This installed Atlas Runtime must be started through atlas.cmd so it uses the installed state.');
    error.code = 'ATLAS_RUNTIME_ENTRYPOINT_REQUIRED';
    throw error;
  }
  if (!command || command === '--help' || command === '-h') {
    emit('help', { usage: usage() }, ({ usage: helpText }) => console.log(helpText));
    return;
  }
  if (command === 'help' && args.length === 1 && args[0] === 'foundation') {
    if (isInstalledProductRuntime()) {
      const error = new Error('Foundation command help is available only from the Atlas source workspace.');
      error.code = 'ATLAS_INVALID_ARGUMENT';
      throw error;
    }
    emit('help.foundation', { usage: foundationUsage() }, ({ usage: helpText }) => console.log(helpText));
    return;
  }
  if (command === 'version') {
    if (args.length) throw new Error('version does not accept arguments');
    emit('version', { version: ATLAS_VERSION }, ({ version }) => console.log(`Atlas ${version}`));
    return;
  }
  if (command === 'capabilities') {
    if (args.length) throw new Error('capabilities does not accept arguments');
    emit('capabilities', exposedCapabilities(), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (isInstalledProductRuntime() && new Set(['guarded', 'derive', 'intake']).has(command)) {
    const error = new Error(`The installed Atlas product does not expose ${command}. Use the current Save workflow.`);
    error.code = 'ATLAS_INVALID_ARGUMENT';
    throw error;
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

  if (command === 'resource') {
    const [area, action, ...rest] = args;
    if (area === 'show') {
      const resourceId = action;
      let projectId = null;
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--project') projectId = rest[++index];
        else throw new Error(`Unknown resource show argument: ${rest[index]}`);
      }
      if (!resourceId || !projectId) throw new Error('resource show requires a resource_id and --project');
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger });
      try {
        const entry = tableWorkProject(registry, projectId);
        const resource = control.projectResource(projectId, resourceId, { refresh: true });
        const dataWork = createDataWorkService({ stateDir, projectRoot, installationRoot, resourceControl: control });
        const workSessions = dataWork.openProjectSessions(entry.project);
        const savedWork = createSavedWorkService({ stateDir }).listForProject(projectId);
        const boardService = createBoardService({ stateDir, registry, resourceControl: control, projectRoot, installationRoot });
        try {
          emit('resource.show', {
            ...resource,
            impact_lanes: buildResourceImpactLanes({ resource, workSessions, savedWork }),
            board_references: boardService.listResourceReferences(projectId, resourceId),
          }, (data) => console.log(JSON.stringify(data, null, 2)));
        } finally { boardService.dispose(); }
      } finally { control.dispose(); registry.dispose(); }
      return;
    }
    if (area !== 'relationships' || action !== 'submit') throw new Error('Use atlas resource show or resource relationships submit.');
    let requestFile = null; let tool = null; let clientRunId = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--request-file') requestFile = rest[++index];
      else if (rest[index] === '--tool') tool = rest[++index];
      else if (rest[index] === '--client-run-id') clientRunId = rest[++index];
      else throw new Error(`Unknown resource relationships argument: ${rest[index]}`);
    }
    if (!requestFile) throw new Error('resource relationships submit requires --request-file <json>.');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const control = createResourceControl({ stateDir });
    try { emit('resource.relationships.submit', { relationships: control.submitRelationships({ candidates: request.candidates, caller: { tool, client_run_id: clientRunId } }) }, (data) => console.log(JSON.stringify(data, null, 2))); }
    finally { control.dispose(); }
    return;
  }
  if (command === 'view') {
    const service = createProjectViewService({ stateDir });
    try { handleProjectViews(service, args); }
    finally { service.dispose(); }
    return;
  }

  if (command === 'content') {
    const options = parseContent(args);
    if (options.action === 'inspect') {
      const project = options.callerProvided
        ? projectForHostInspection(options.projectId, options.filePath)
        : null;
      const resourceControl = options.callerProvided ? createResourceControl({ stateDir }) : null;
      const activity = options.callerProvided
        ? beginCurrentActivity({
          stateDir,
          filePath: options.filePath,
          purpose: options.purpose,
          caller: options.caller,
          project,
          resourceId: resourceControl?.identify({ filePath: options.filePath, project })?.resource_id ?? null,
        })
        : null;
      try {
        const inspection = inspectContent({ stateDir, projectRoot, installationRoot, ...options });
        let coordination = {
          saving_point_recorded: false,
          reason: 'Caller metadata was not supplied.',
        };
        if (options.callerProvided) {
          const sourceFingerprint = contentFileFingerprint(options.filePath);
          if (sourceFingerprint.sha256 !== inspection.source?.sha256) {
            const error = new Error('The file changed while Atlas was inspecting it. Inspect the current file again.');
            error.code = 'ATLAS_STATE_CONFLICT';
            throw error;
          }
          const work = recordInspectionWork({
            stateDir,
            filePath: options.filePath,
            inspect: options,
            inspection,
            sourceFingerprint,
            project,
            caller: options.caller,
            channel: 'host',
            resourceControl,
          });
          coordination = {
            saving_point_recorded: true,
            work_id: work.work_id,
            resource_id: work.resource_id,
            initiated_by: work.initiated_by,
            project: work.project,
            activity_visible_in_desktop: true,
            result_source: inspection.cache_hit ? 'existing_cache' : 'local_processing',
          };
        }
        if (activity) finishCurrentActivity(stateDir, activity.activity_id);
        resourceControl?.dispose();
        const fullResult = { ...inspection, coordination };
        const result = options.compact ? compactContentInspection(fullResult) : fullResult;
        emit('content.inspect', result, (detail) => {
          if (detail.compact) {
            console.log(`Inspected ${detail.source.name} locally; ${detail.summary.label}.`);
          } else {
            console.log(
              `Inspected ${detail.source.name} locally with ${detail.processor.name}; `
              + `${detail.attention.screenshots_used} screenshot(s).`,
            );
          }
        });
      } catch (error) {
        if (activity) {
          try {
            failCurrentActivity({ stateDir, activityId: activity.activity_id, error });
          } catch {
            // Preserve the actual inspection error when activity state also cannot be updated.
          }
        }
        resourceControl?.dispose();
        throw error;
      }
    } else if (options.action === 'prepare-data') {
      const result = prepareDataWorkspace({ stateDir, projectRoot, installationRoot, ...options });
      emit('content.prepare-data', compactDataWorkspaceReceipt(result), (detail) => {
        console.log(
          `Prepared ${detail.summary.rows} local row(s); quality ${detail.summary.quality}; `
          + `review: ${detail.review_path}`,
        );
      });
    } else if (options.action === 'prepare-context') {
      const result = prepareContextPack({ stateDir, projectRoot, installationRoot, ...options });
      emit('content.prepare-context', compactContextPackReceipt(result), (detail) => {
        console.log(
          `Prepared Context Pack ${detail.context_pack_id}; ${detail.selection.included_columns.length} field(s); `
          + `review: ${detail.review_path}`,
        );
      });
    } else if (options.action === 'compare') {
      const result = compareContent({ stateDir, projectRoot, installationRoot, ...options });
      emit('content.compare', result, (detail) => {
        console.log(`Compared content locally: ${detail.relation.type} (${detail.relation.basis}).`);
      });
    } else if (options.action === 'branches') {
      const result = compareContentBranches({ stateDir, projectRoot, installationRoot, ...options });
      emit('content.branches', result, (detail) => {
        console.log(
          `Built ${detail.segments.length} local chat segment(s); `
          + `${detail.evidence.duplicate_records_avoided} duplicate record read(s) avoided.`,
        );
      });
    } else {
      const registry = new Registry({ stateDir });
      const saveService = new SaveService({ stateDir });
      try {
        const result = prepareConversationSave({ stateDir, registry, saveService, ...options });
        emit('content.localize-conversation', result, (detail) => console.log(`Prepared ${detail.decision_count} selected decisions for Save ${detail.save_id}; review ${detail.desktop_href}.`));
      } finally { saveService.dispose(); registry.dispose(); }
    }
    return;
  }

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
  const save = new SaveService({ stateDir, intake });
  const portfolio = new Portfolio({ stateDir });
  const registry = new Registry({ stateDir });
  const catalog = new Catalog({ stateDir, registry });
  const storage = new RuntimeStorage({ stateDir, ledger: tracker.ledger });
  const capture = new BrowserCapture({ stateDir, storage });
  const rules = new PreferenceRules({ stateDir, ledger: tracker.ledger });
  try {
    if (command === 'doctor') {
      if (args.length === 1 && args[0] === 'ui') {
        const data = doctorDesktopUiComponent({ installationRoot, runtimeRoot: projectRoot });
        emit('doctor.ui', data, (detail) => {
          console.log(`Atlas Desktop UI doctor: ${detail.status}; ${detail.mode}.`);
        });
        return;
      }
      if (args.length) throw new Error('doctor accepts only the optional ui target');
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
          content_python: optionalPythonCapability(),
          desktop_ui: doctorDesktopUiComponent({ installationRoot, runtimeRoot: projectRoot }),
        },
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
    } else if (command === 'portfolio') {
      handlePortfolio(portfolio, args);
    } else if (command === 'guarded') {
      handleGuarded(guarded, args);
    } else if (command === 'derive') {
      handleDerived(derived, args);
    } else if (command === 'intake') {
      handleIntake(intake, args);
    } else if (command === 'save') {
      handleSave(save, args);
    } else if (command === 'table-work') {
      await handleTableWork(registry, save, args);
    } else if (command === 'board') {
      await handleBoard(registry, save, args);
    } else if (command === 'round') {
      handleRound(registry, args);
    } else if (command === 'evolve') {
      handleEvolution(evolution, args);
    } else if (command === 'work') {
      handleWork(storage, args);
    } else if (command === 'capture') {
      await handleCapture(capture, args);
    } else if (command === 'storage') {
      handleStorage(storage, args);
    } else if (command === 'root') {
      handleRoot(registry, args);
    } else if (command === 'catalog') {
      handleCatalog(catalog, args);
    } else if (command === 'project') {
      handleProject(registry, args);
    } else if (command === 'ui') {
      if (!args[0] || args[0].startsWith('--')) {
        const options = {
          currentPath: null, port: 0, mode: 'desktop',
        };
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === '--path') options.currentPath = args[++index];
          else if (args[index] === '--port') options.port = Number(args[++index]);
          else if (args[index] === '--no-open') options.mode = 'host_only';
          else if (args[index] === '--browser') options.mode = 'browser_debug';
          else throw new Error(`Unknown ui argument: ${args[index]}`);
        }
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
          throw new Error('ui accepts an optional --path, --port, --no-open, or --browser.');
        }
        const diagnostics = tracker.ledger.diagnostics();
        const session = await startAtlasUiServer({
          stateDir,
          currentPath: options.currentPath,
          registry,
          rules,
          runtime: {
            atlas_version: ATLAS_VERSION,
            node_version: process.versions.node,
            runtime_root: projectRoot,
            state_dir: stateDir,
            installation_root: installationRoot,
            ledger: {
              integrity: diagnostics.integrity,
              schema_version: diagnostics.schema_version,
              supported_schema_version: diagnostics.supported_schema_version,
            },
            python: optionalPythonCapability(),
          },
          intake,
          projectRoot,
          installationRoot,
          port: options.port,
          desktopPickerEnabled: options.mode === 'desktop',
        });
        let surface = { status: 'not_requested', mode: options.mode };
        let desktop = null;
        if (options.mode === 'desktop') {
          try {
            desktop = await startDesktopUi({
              url: session.url,
              installationRoot,
              runtimeRoot: projectRoot,
              pickerRegistrationUrl: session.desktop_picker?.registration_url,
              pickerToken: session.desktop_picker?.token,
            });
            surface = {
              status: desktop.status,
              mode: 'desktop',
              renderer: desktop.renderer,
              pid: desktop.pid,
              external_browser: false,
            };
          } catch (error) {
            await session.close();
            throw error;
          }
        } else if (options.mode === 'browser_debug') {
          surface = { ...openLocalUi(session.url), mode: 'browser_debug', external_browser: true };
        }
        emit('ui.start', {
          schema: session.schema,
          url: session.url,
          workspace_url: session.workspace_url,
          network_scope: session.network_scope,
          surface,
          source_changes: [],
        }, (detail) => {
          if (detail.surface.mode === 'desktop') console.log('Atlas Desktop is open. Close the window to stop.');
          else if (detail.surface.mode === 'browser_debug') console.log(`Atlas browser debug UI: ${detail.url}`);
          else console.log(`Atlas UI host: ${detail.url}\nPress Ctrl+C to stop.`);
        });
        const stopped = new Promise((resolve, reject) => {
          const stop = () => session.close().then(resolve, reject);
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          session.closed.then(resolve, reject);
        });
        if (desktop) {
          await Promise.race([stopped, desktop.closed]);
          desktop.close();
          await session.close();
        } else {
          await stopped;
        }
      } else if (args[0] === 'doctor') {
        if (args.length !== 1) throw new Error('ui doctor does not accept arguments.');
        const result = doctorDesktopUiComponent({ installationRoot, runtimeRoot: projectRoot });
        emit('ui.doctor', result, (detail) => {
          console.log(`Atlas Desktop UI: ${detail.status}; ${detail.mode}.`);
          if (detail.next_step) console.log(detail.next_step);
        });
      } else if (args[0] === 'install') {
        let sourcePython = null;
        for (let index = 1; index < args.length; index += 1) {
          if (args[index] === '--python') sourcePython = args[++index];
          else throw new Error(`Unknown ui install argument: ${args[index]}`);
        }
        const result = installDesktopUiComponent({
          installationRoot,
          runtimeRoot: projectRoot,
          sourcePython,
        });
        emit('ui.install', result, (detail) => {
          console.log(`Atlas Desktop UI: ${detail.status}; Python ${detail.python_version}.`);
        });
      } else if (args[0] === 'remove') {
        if (args.length !== 1) throw new Error('ui remove does not accept arguments.');
        const result = removeDesktopUiComponent({ installationRoot });
        emit('ui.remove', result, (detail) => {
          console.log(`Atlas Desktop UI: ${detail.status}; Node governance preserved.`);
        });
      } else {
        throw new Error('ui requires install, doctor, or remove');
      }
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
      const positional = args.filter((arg) => !arg.startsWith('--'));
      if (positional.length !== 1) throw new Error('show requires one run_id');
      if (args.some((arg) => arg.startsWith('--') && arg !== '--compact')) {
        throw new Error('show accepts only --compact');
      }
      const runId = positional[0];
      const detail = tracker.show(runId);
      emit('show', args.includes('--compact') ? compactRunDetail(detail) : detail, printShow);
    } else if (command === 'rollback') {
      if (args.length !== 1) throw new Error('rollback requires one run_id');
      const receipt = tracker.rollback(args[0]);
      emit('rollback', receipt, () => console.log(`Rolled back ${receipt.run_id}: restored ${receipt.restored_files} file(s).`));
    } else if (command === 'gc') {
      const result = tracker.gc(parseGc(args));
      emit('gc', result, () => console.log(`GC: deleted ${result.deleted_blobs} blob(s), ${result.deleted_bytes} byte(s); kept ${result.skipped_referenced} referenced and ${result.skipped_recent} recent.`));
    } else {
      const error = new Error(`Unknown command: ${command}\n\n${usage()}`);
      error.code = 'ATLAS_INVALID_ARGUMENT';
      throw error;
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
    catalog.dispose();
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
