#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { BrowserCapture } from '../src/browser-capture.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createCaptureSourceModule } from '../src/capture-source-module.js';
import { createContentLocationService } from '../src/content-location-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';
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
import { createHandoffService } from '../src/handoff-service.js';
import { WorkspaceInspector } from '../src/inspect.js';
import { Portfolio } from '../src/portfolio.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';
import { createProjectMoveService } from '../src/project-move-service.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';
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
import { buildResourceFocusGraph, buildResourceImpactLanes } from '../src/ui/services/resource-impact-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { createModuleAvailabilityService } from '../src/module-availability.js';
import { createLocalModuleService } from '../src/local-module.js';
import {
  ATLAS_VERSION,
  CAPABILITIES,
  currentCommandHelp,
  MODULE_PROTOCOL_VERSION,
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
  Current product: atlas ui; atlas view; atlas table-work; atlas board; atlas save; atlas capture source inspect-export/prepare-export/prepare/show/read
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
  atlas capture source prepare --url <public_url> --project <project_id> --folder <existing_project_folder>
                               --name <base_name> --request-key <key> --tool <host> --client-run-id <id>
  atlas capture source inspect-export --input <conversations.json> [--limit <1..100>] [--cursor <opaque>] [--json]
  atlas capture source prepare-export --input <conversations.json> --expected-input-sha256 <hash> --selection <index:hash>
                                      --project <project_id> --folder <existing_project_folder> --name <base_name>
                                      --request-key <key> --tool <host> --client-run-id <id> --json
  atlas capture source show <save_id> --project <project_id>
  atlas capture source read <save_id> --project <project_id> [--mode <full|changes>] [--cursor <opaque>] [--characters <1..4000>]
  atlas document update batch prepare --project <project_id> --request-file <json_with_reviewed_items>
    --request-key <key> --tool <tool> --client-run-id <id> --json
  atlas document update batch show <batch_id> --project <project_id> --json
  atlas document update batch advance <batch_id> --project <project_id> --expected-revision <n>
    --expected-digest <hash> --request-key <key> --tool <tool> --client-run-id <id> --json
  atlas document update inspect --project <project_id> --resource <resource_id> --json
  atlas document update prepare --project <project_id> --resource <resource_id> --expected-sha256 <hash>
                                --old-text-file <path> --new-text-file <path> --source-save <save_id>
                                --request-key <key> --tool <host> --client-run-id <id> --json
  atlas document update prepare --project <project_id> --resource <resource_id> --expected-sha256 <hash>
                                --request-file <link-source-and-patch.json>
                                --request-key <key> --tool <host> --client-run-id <id> --json
  atlas document update show <update_id> --project <project_id> --json
  atlas document update execute|undo|recover <update_id> --project <project_id> --expected-revision <n>
    --expected-current-sha256 <hash> --request-key <key> --tool <tool> --client-run-id <id> --json
  atlas document update decide <update_id> --project <project_id> --expected-revision <n>
                               --expected-current-sha256 <hash> --decision <keep-current|accept-suggestion|revise>
                               [--text-file <path>] --request-key <key> --tool <host> --client-run-id <id> --json
  atlas content inspect --file <path> [--purpose <structure|content|data|visual>]
                        [--sheet <xlsx_sheet_name>]
                        [--max-characters <500..20000>]
                        [--project <project_id>]
                        [--compact]
                        [--actor <actor>] [--agent <name>] [--model <name>]
                        [--tool <name>] [--client-run-id <id>]
  atlas content locate --project <project_id> --resource <resource_id> [--sheet <exact_name>] [--cell <A1>] [--page <1-based> --cursor <opaque>] [--page <1-based> --x <pt> --y <pt> --width <pt> --height <pt>] [--page <1-based> --tables | --table-index <1-based>] [--limit <1..50>] --json
  atlas content row --project <project_id> --resource <resource_id> (--sheet <exact_name> --row <Excel_row> | --key-column <column> --key-value <value>) --json
  atlas content read-ref --project <project_id> --ref <opaque_reference> --json
  atlas resource relationships preview --request-file <json> --json
  atlas resource relationships submit --request-file <json> --confirm-preview <token> --request-key <key> --tool <name> --client-run-id <id>
  atlas resource relationships suggest --request-file <json> --request-key <key> --tool <name> --client-run-id <id> --json
  atlas resource relationships suggestions --project <project_id> --json
  atlas resource relationships suggestion --project <project_id> --candidate <candidate_id> --json
  atlas resource relink preview --request-file <json> --json
  atlas resource relink confirm --request-file <json> --preview-digest <sha256> --request-key <key> --tool <name> --client-run-id <id> --json
  atlas resource show <resource_id> --project <project_id>
  atlas board list --project <project_id>
  atlas board create --project <project_id> --title <title>
  atlas board show <board_id> --project <project_id>
  atlas board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>
  atlas board export <board_id> --project <project_id> --base-revision <revision> --target <folder/file.html|folder/file.md> --request-key <key> --tool <tool> --client-run-id <id>
  atlas view list --project <project_id>
  atlas view properties --project <project_id>
  atlas view save --project <project_id> --request-file <view.json> --tool <host> --client-run-id <id>
  atlas view candidates show <batch_id> --project <project_id>
  atlas view evaluate <view_id> [--limit <1..250>] [--continuation <opaque_token>]
    Registered-local Views default to 20 and accept limits 1..100; directory Views default to 100 and accept limits 1..250.
  atlas view files --project <project_id> --scope <relative_folder_or_.> [--extension <ext> ...]
                   [--no-recursive] [--limit <1..250>] [--continuation <opaque_token>]
  atlas view candidates submit --project <project_id> --request-file <json>
  atlas view row-candidates submit|show --project <project_id> [--request-file <json>]
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
  atlas table-work focus <session_id> --base-revision <revision> (--category <value>|--clear) --tool <tool> --client-run-id <id>
  atlas table-work details <session_id> --base-revision <revision> [--offset <n>] [--limit <1..50>]
  atlas table-work save <session_id> --folder <existing_relative_folder> --file-name <new.csv|new.xlsx>
                        --format <csv|xlsx> --base-revision <revision> --request-key <key> --reason <authorization>
                        --tool <name> --client-run-id <id>
  atlas content prepare-data --file <csv|tsv|xlsx> [--sheet <xlsx_sheet_name>]
  atlas content prepare-context --file <csv|tsv|xlsx> [--sheet <name>] --purpose <text> --include-column <exact_name> [...]
  atlas content compare --left <path> --right <path> [--details]
    [--key-column <header>] [--period-column <header>] [--event-date-column <header>] [--left-sheet <name>] [--right-sheet <name>]
  atlas content branches --file <jsonl_path> --file <jsonl_path> [--file <jsonl_path> ...]
  atlas content localize-conversation --input <selection.json> --project <project_id>
                                      --request-key <key> --tool <host> --client-run-id <id>
                                      --output-relative <new_file.md>
                                      --actor <actor> --agent <name> --model <name>
                                      --tool <name> --client-run-id <id>
  atlas work stage --file <path> --kind <candidate|proposal|intermediate> [--ttl-hours <number>]
  atlas work status [work_id] | release <work_id> [--reason <text>]
  atlas save plan --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                  [--origin <origin>] [--kind <kind>] [--input <related_path> ...]
  atlas save prepare --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                     [--origin <origin>] [--kind <kind>] [--input <related_path> ...]
                     [--expected-plan-revision <plan_revision>]
                     --channel <host|import|work> --request-key <key> --tool <tool> --client-run-id <id>
  atlas save directory prepare --root <path> --candidate-file <path> --project <project_id> --target <new_relative_path>
                               --expected-plan-revision <revision> --tool <tool> --client-run-id <id>
  atlas save directory show <evolution_run_id>
  atlas save review <save_id> | show <save_id> | execute <save_id> --reason <text>
                     [--expected-preview-revision <preview_revision>]
  atlas save undo <save_id> | redo <save_id>
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
  atlas bootstrap connect <scan_id> --type <root_type> --content-policy <structure_only|bounded_content> --reason <text>
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
  atlas rule pending --root <path> --project <project_id> [--cursor <cursor>]
  atlas rule context --root <path> --request-file <json>
  atlas rule propose --root <path> --proposal-file <json> [agent options]
  atlas rule preview <rule_change_id>
  atlas rule approve | reject <rule_change_id> --reason <text>
  atlas rule disable-preview <rule_id>
  atlas rule disable <rule_id> --expected-preview-revision <hash> --reason <text>
  atlas project create --name <name> --path <relative_path> [--alias <name> ...]
  atlas project list | show <project_id> | evolve <project_id> [--name <name>] [--alias <name>] [--status <status>]
  atlas project move prepare --request-file <json>
  atlas project membership prepare --request-file <json>
  atlas project membership show|execute|undo|recover <operation_id> --request-file <json>
  atlas project move show|execute|undo|recover <move_id> --request-file <json>
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

Current Host discovery and continuation:
${currentCommandHelp()}

Current product:
  atlas module list --json
  atlas module package-preview --file <local_json_path> --json
  atlas module install --file <local_json_path> --expected-sha256 <hash> --expected-revision <n> --request-key <key> --json
  atlas module package-list --json
  atlas module preview <module_id> --project <id> --resource <resource_id> --json
  atlas module save <module_id> --project <id> --resource <resource_id> --target <new_relative_path>
                     --request-key <key> --tool <tool> --client-run-id <id> --json
  atlas module disable <module_id> --expected-revision <n> --request-key <key> --reason <text>
  atlas module enable <module_id> --expected-revision <n> --request-key <key> --reason <text>
  atlas ui [--path <current_directory>] [--port <port>] [--no-open|--browser]
  atlas ui install --python <python-3.11-or-newer>
  atlas ui doctor | remove
  atlas save plan --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                  [--origin <origin>] [--kind <kind>] [--input <related_path> ...]
  atlas save prepare --root <path> --candidate-file <path> --project <project_id> [--target <new_relative_path>]
                     [--origin <origin>] [--kind <kind>] [--input <related_path> ...]
                     [--expected-plan-revision <plan_revision>] --channel <host|import|work>
                     --request-key <key> --tool <tool> --client-run-id <id>
  atlas save directory prepare --root <path> --candidate-file <path> --project <project_id> --target <new_relative_path>
                               --expected-plan-revision <revision> --tool <tool> --client-run-id <id>
  atlas save directory show <evolution_run_id>
  atlas save review <save_id>
  atlas save show <save_id>
  atlas save execute <save_id> --reason <text> [--expected-preview-revision <preview_revision>]
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
  atlas table-work focus <session_id> --base-revision <revision> (--category <value>|--clear)
  atlas table-work details <session_id> --base-revision <revision> [--offset <n>] [--limit <1..50>]
  atlas table-work save <session_id> --folder <existing_folder> --file-name <new_name>
                        --format <csv|xlsx> --base-revision <revision> --request-key <key> --reason <authorization>
                         --tool <name> --client-run-id <id>

  atlas board list --project <project_id>
  atlas board create --project <project_id> --title <title>
  atlas board show <board_id> --project <project_id>
  atlas board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>
  atlas board export <board_id> --project <project_id> --base-revision <revision>
                     --target <existing_folder/new.html|new.md> --request-key <key> --tool <host> --client-run-id <id>

  atlas view list --project <project_id>
  atlas view properties --project <project_id>
  atlas view save --project <project_id> --request-file <view.json> --tool <host> --client-run-id <id>
  atlas view candidates show <batch_id> --project <project_id>
  atlas view evaluate <view_id> [--limit <1..250>] [--continuation <opaque_token>]
    Registered-local Views default to 20 and accept limits 1..100; directory Views default to 100 and accept limits 1..250.
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
  atlas content compare --left <path> --right <path> [--details]
    [--key-column <header>] [--period-column <header>] [--event-date-column <header>] [--left-sheet <name>] [--right-sheet <name>]
  atlas content locate --project <project_id> --resource <resource_id> [--page <1-based> --cursor <opaque>] [--page <1-based> --x <pt> --y <pt> --width <pt> --height <pt>] [--page <1-based> --tables | --table-index <1-based>] [--limit <1..50>] --json
  atlas content read-ref --project <project_id> --ref <opaque_reference> --json
  atlas resource relationships preview --request-file <json> --json
  atlas resource relationships submit --request-file <json> [--confirm-preview <token> --request-key <key>] --tool <name> --client-run-id <id>
  atlas resource relink preview --request-file <json> --json
  atlas resource relink confirm --request-file <json> --preview-digest <sha256> --request-key <key> --tool <name> --client-run-id <id> --json
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

function parseBootstrapConnect(args) {
  const scanId = args[0];
  if (!scanId || scanId.startsWith('--')) throw new Error('bootstrap connect requires a scan_id');
  let rootType = null;
  let contentPolicy = null;
  let reason = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--type' && args[index + 1] !== undefined) rootType = args[++index];
    else if (args[index] === '--content-policy' && args[index + 1] !== undefined) contentPolicy = args[++index];
    else if (args[index] === '--reason' && args[index + 1] !== undefined) reason = args[++index];
    else throw new Error(`Unknown bootstrap connect argument: ${args[index]}`);
  }
  if (!rootType || !contentPolicy || !reason?.trim()) {
    throw new Error('bootstrap connect requires --type, --content-policy, and --reason');
  }
  return { scanId, rootType, contentPolicy, reason };
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
  } else if (action === 'connect') {
    const { scanId, ...options } = parseBootstrapConnect(rest);
    const receipt = bootstrap.connect(scanId, options);
    emit('bootstrap.connect', receipt, () => console.log(`Connected ${receipt.projects.length} Project(s) to Root ${receipt.root_id}.`));
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
  if (action === 'membership') {
    const [membershipAction, ...argumentsList] = rest;
    if (!['prepare', 'show', 'execute', 'undo', 'recover'].includes(membershipAction)) throw new Error('Use project membership prepare|show|execute|undo|recover --request-file <json>.');
    let requestFile = null; let operationId = null;
    for (let i = 0; i < argumentsList.length; i++) {
      if (argumentsList[i] === '--request-file') requestFile = argumentsList[++i];
      else if (!operationId && !argumentsList[i].startsWith('--')) operationId = argumentsList[i];
      else throw new Error(`Unknown project membership argument: ${argumentsList[i]}`);
    }
    if (!requestFile || membershipAction !== 'prepare' && !operationId) throw new Error('Membership requires --request-file; show/execute/undo/recover also require operation_id.');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const service = createProjectMembershipService({ stateDir: registry.stateDir, registry });
    try {
      const result = membershipAction === 'prepare' ? service.prepare(request) : service[membershipAction](operationId, request);
      emit(`project.membership.${membershipAction}`, result, () => console.log(JSON.stringify(result, null, 2)));
    } finally { service.dispose(); }
    return;
  }
  if (action === 'move') {
    const [moveAction, ...argumentsList] = rest;
    if (!['prepare', 'show', 'execute', 'undo', 'recover'].includes(moveAction)) {
      throw new Error('Project moves require a reviewed preview. The former project move <project_id> --path syntax is no longer supported. Use atlas project move prepare --request-file <json> --json with projectId, targetRelativePath (inside the attached Root), requestKey and caller. Read the returned move_id, revision and digest; after confirmation use atlas project move execute <move_id> --request-file <json> --json with projectId, expectedRevision, expectedDigest, requestKey and caller. No Project path was changed.');
    }
    let requestFile = null; let moveId = null;
    for (let i = 0; i < argumentsList.length; i++) {
      if (argumentsList[i] === '--request-file') requestFile = argumentsList[++i];
      else if (!moveId && !argumentsList[i].startsWith('--')) moveId = argumentsList[i];
      else throw new Error(`Unknown project move argument: ${argumentsList[i]}`);
    }
    if (!requestFile || moveAction !== 'prepare' && !moveId) throw new Error('project move requires --request-file; show/execute/undo/recover also require move_id.');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const service = createProjectMoveService({ stateDir: registry.stateDir, registry });
    try {
      const result = moveAction === 'prepare' ? service.prepare(request) : service[moveAction](moveId, request);
      emit(`project.move.${moveAction}`, result, () => console.log(JSON.stringify(result, null, 2)));
    } finally { service.dispose(); }
    return;
  }
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
    throw new Error('Legacy project merge only changed Project metadata and is disabled. Use project membership prepare --request-file <json> with operation:"merge", sourceProjectId, targetProjectId and targetRelativePath; inspect the preview before execute with expectedRevision and expectedDigest.');
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
      promptVersion: request.prompt_version ?? null,
      candidates: request.candidates,
      caller: callerFromOptions(options),
    });
    emit('view.candidates.submit', result, (data) => console.log(`Stored ${data.candidates.length} Property suggestion${data.candidates.length === 1 ? '' : 's'} for user review.`));
    return;
  }
  if (action === 'row-candidates') {
    const subaction = rest.shift();
    if (subaction === 'show') {
      if (rest.length !== 3 || !rest[0] || rest[1] !== '--project' || !rest[2]) throw new Error('view row-candidates show requires one batch_id and --project <project_id>.');
      emit('view.row-candidates.show', service.rowPropertyCandidateBatch({ batchId: rest[0], projectId: rest[2] }), (data) => console.log(JSON.stringify(data, null, 2)));
      return;
    }
    if (subaction !== 'submit') throw new Error('view row-candidates requires submit or show.');
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--request-file') options.requestFile = rest[++index];
      else { const consumed = parseCallerFlag(options, rest, index); if (consumed == null) throw new Error(`Unknown row-candidates submit argument: ${rest[index]}`); index = consumed; }
    }
    if (!options.projectId || !options.requestFile || !options.tool || !options.model || !options.clientRunId) throw new Error('view row-candidates submit requires --project, --request-file, --tool, --model, and --client-run-id.');
    const request = readJsonFile(options.requestFile, 'Row property candidate request');
    emit('view.row-candidates.submit', service.submitRowPropertyCandidates({ projectId: options.projectId,
      propertyId: request.property?.property_id, promptVersion: request.prompt_version, phase: request.phase ?? 'preview',
      previewBatchId: request.preview_batch_id ?? null, candidates: request.candidates,
      caller: callerFromOptions(options) }), (data) => console.log(`Stored ${data.candidates.length} row candidate${data.candidates.length === 1 ? '' : 's'} for review.`));
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
    let limit = null; let continuation = null;
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
  if (action === 'pending') {
    let root = null;
    let projectId = null;
    let cursor = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--root') root = rest[++index];
      else if (rest[index] === '--project') projectId = rest[++index];
      else if (rest[index] === '--cursor') cursor = rest[++index];
      else throw new Error(`Unknown rule pending argument: ${rest[index]}`);
    }
    if (!root || !projectId) throw new Error('rule pending requires --root and --project');
    const page = rules.pendingPage({ root, projectId, cursor });
    emit('rule.pending', page, (data) => {
      console.log(`${data.items.length} pending proposal(s)${data.has_more ? '; more available.' : '.'}`);
    });
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
  if (action === 'disable-preview') {
    if (rest.length !== 1) throw new Error('rule disable-preview requires one rule_id');
    emit('rule.disable-preview', rules.previewDisable(rest[0]), (data) => console.log(JSON.stringify(data, null, 2)));
    return;
  }
  if (action === 'disable') {
    const ruleId = rest[0];
    if (!ruleId || ruleId.startsWith('--')) throw new Error('rule disable requires one rule_id');
    const options = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--expected-preview-revision') options.expectedPreviewRevision = rest[++index];
      else if (rest[index] === '--reason') options.reason = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown rule disable argument: ${rest[index]}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const result = rules.disable(ruleId, options);
    emit('rule.disable', result, (data) => console.log(`Disabled ${data.rule_id}.`));
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

function handleSave(save, evolution, registry, args) {
  const [action, ...rest] = args;
  if (action === 'directory') {
    const [directoryAction, ...directoryArgs] = rest;
    if (directoryAction === 'show') {
      if (directoryArgs.length !== 1) throw new Error('save directory show requires one Evolution run_id');
      const detail = evolution.preview(directoryArgs[0]);
      const context = detail.plan?.save_directory;
      if (!context) throw new Error(`Evolution run is not a Project Save directory review: ${directoryArgs[0]}`);
      emit('save.directory.show', {
        run_id: detail.run.id,
        status: detail.run.status,
        project_id: context.project_id,
        root: context.root,
        directory_path: context.directory_path,
        save_target: context.save_target,
        plan_revision: context.plan_revision,
        plan_hash: detail.operation.plan_hash,
        execution_receipt: detail.execution_receipt,
        rollback_receipt: detail.rollback_receipt,
      }, (data) => console.log(`${data.run_id}: ${data.status}; ${data.directory_path}.`));
      return;
    }
    if (directoryAction !== 'prepare') throw new Error(`Unknown save directory action: ${directoryAction ?? '(missing)'}`);
    const options = { inputs: [] };
    for (let index = 0; index < directoryArgs.length; index += 1) {
      const token = directoryArgs[index];
      if (token === '--root') options.root = directoryArgs[++index];
      else if (token === '--candidate-file') options.candidateFile = directoryArgs[++index];
      else if (token === '--origin') options.origin = directoryArgs[++index];
      else if (token === '--kind') options.kind = directoryArgs[++index];
      else if (token === '--project') options.projectId = directoryArgs[++index];
      else if (token === '--target') options.target = directoryArgs[++index];
      else if (token === '--input') options.inputs.push(directoryArgs[++index]);
      else if (token === '--relation') options.relationType = directoryArgs[++index];
      else if (token === '--intent') options.intent = directoryArgs[++index];
      else if (token === '--expected-plan-revision') options.expectedPlanRevision = directoryArgs[++index];
      else {
        const consumed = parseCallerFlag(options, directoryArgs, index);
        if (consumed == null) throw new Error(`Unknown save directory prepare argument: ${token}`);
        index = consumed;
      }
    }
    if (!options.root || !options.candidateFile || !options.projectId || !options.target
      || !options.expectedPlanRevision) {
      throw new Error('save directory prepare requires --root, --candidate-file, --project, --target, and --expected-plan-revision.');
    }
    options.caller = callerFromOptions(options);
    const root = fs.realpathSync.native(path.resolve(options.root));
    const planOptions = {
      root,
      candidateFile: options.candidateFile,
      projectId: options.projectId,
      target: options.target,
      origin: options.origin,
      kind: options.kind,
      inputs: options.inputs,
      relationType: options.relationType,
      intent: options.intent,
    };
    const plan = save.plan(planOptions);
    if (plan.status !== 'needs_structure_change' || plan.plan_revision !== options.expectedPlanRevision || !plan.target) {
      const error = new Error('Save plan changed or does not require a single directory change; review the current plan.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    const projectDetail = registry.show(options.projectId);
    const project = projectDetail.project;
    const location = projectDetail.location;
    if (project?.status !== 'active' || !location || location.root_path !== root
      || location.relative_path !== project.current_path) {
      const error = new Error('Save directory preparation requires an active Project attached to this Root.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    const targetRelative = String(plan.target).replaceAll('\\', '/');
    const directoryPath = path.posix.dirname(targetRelative);
    const parentPath = path.posix.dirname(directoryPath);
    if (directoryPath === '.' || !targetRelative.startsWith(`${project.current_path}/`)
      || !directoryPath.startsWith(`${project.current_path}/`)) {
      const error = new Error('Save target is outside the attached Project or has no single missing parent directory.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    const absoluteDirectory = path.resolve(root, ...directoryPath.split('/'));
    const absoluteParent = path.resolve(root, ...parentPath.split('/'));
    const absoluteTarget = path.resolve(root, ...targetRelative.split('/'));
    if (fs.existsSync(absoluteDirectory) || !fs.existsSync(absoluteParent) || fs.existsSync(absoluteTarget)) {
      const error = new Error('Only one absent Save parent directory with an existing parent and absent file can be prepared.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    const identity = (directory) => {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
      return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtime_ns: stat.birthtimeNs.toString() };
    };
    const context = {
      project_id: project.id,
      root,
      root_id: location.root_id,
      project_path: project.current_path,
      directory_path: directoryPath,
      parent_path: parentPath,
      save_target: targetRelative,
      plan_revision: plan.plan_revision,
      save_options: planOptions,
      root_identity: identity(root),
      project_identity: identity(path.resolve(root, ...project.current_path.split('/'))),
      parent_identity: identity(absoluteParent),
    };
    const prepared = evolution.prepare({
      root,
      operation: 'create_directory',
      target: directoryPath,
      projectId: project.id,
      intent: `Prepare the missing Save directory for ${targetRelative}.`,
      caller: options.caller,
      saveDirectory: context,
      internalPreflight: () => {
        const current = save.plan(planOptions);
        if (current.status !== 'needs_structure_change'
          || current.plan_revision !== context.plan_revision
          || String(current.target ?? '').replaceAll('\\', '/') !== context.save_target) {
          const error = new Error('Save plan changed before the locked directory Prepare; review it again.');
          error.code = 'ATLAS_STATE_CONFLICT';
          throw error;
        }
      },
    });
    emit('save.directory.prepare', {
      ...prepared,
      project_id: project.id,
      root,
      directory_path: directoryPath,
      save_target: targetRelative,
      plan_revision: context.plan_revision,
      review_href: `/projects/${encodeURIComponent(project.id)}/save-directory/${encodeURIComponent(prepared.run_id)}`,
    }, (data) => console.log(`Prepared directory review ${data.run_id}: ${data.directory_path}.`));
    return;
  }
  if (action === 'plan' || action === 'prepare') {
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
      else if (token === '--expected-plan-revision') options.expectedPlanRevision = rest[++index];
      else {
        const consumed = parseCallerFlag(options, rest, index);
        if (consumed == null) throw new Error(`Unknown save prepare argument: ${token}`);
        index = consumed;
      }
    }
    options.caller = callerFromOptions(options);
    const receipt = action === 'plan' ? save.plan(options) : save.prepare(options);
    emit(`save.${action}`, receipt, (data) => console.log(action === 'plan' ? `${data.status}: ${data.target ?? 'no target'}.` : `Prepared ${data.save_id}.`));
    return;
  }
  if (action === 'review') {
    if (rest.length !== 1) throw new Error('save review requires one save_id');
    emit('save.review', save.review(rest[0]), (data) => console.log(`Reviewed ${data.save.save_id}: ${data.preview_revision}.`));
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
    let reason = null; let expectedPreviewRevision = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--reason' && rest[index + 1] !== undefined) reason = rest[++index];
      else if (rest[index] === '--expected-preview-revision' && rest[index + 1] !== undefined) expectedPreviewRevision = rest[++index];
      else throw new Error(`Unknown save execute argument: ${rest[index]}`);
    }
    emit('save.execute', save.execute(saveId, { reason, expectedPreviewRevision }), (data) => console.log(`Saved ${data.save_id}.`));
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
    if (action === 'decide' && token.startsWith('UPD-')) options.updateId = token;
    else if (token === '--project') options.projectId = rest[++index];
    else if (token === '--limit') options.limit = Number(rest[++index]);
    else if (token === '--offset') options.offset = Number(rest[++index]);
    else if (token === '--intent') options.intent = rest[++index];
    else if (token === '--source') options.sources.push(rest[++index]);
    else if (token === '--resource') options.resourceId = rest[++index];
    else if (token === '--source-key') options.sourceKey = rest[++index];
    else if (token === '--decision') options.decision = rest[++index];
    else if (token === '--category') options.category = rest[++index];
    else if (token === '--handoff') options.handoffId = rest[++index];
    else if (token === '--handoff-digest') options.handoffDigest = rest[++index];
    else if (token === '--clear') options.clear = true;
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
  return { project: { id: project.id, name: project.name, status: project.status }, root, workspaceRoot: path.resolve(location.root_path), location };
}

async function handleTableWork(registry, saveService, args, moduleAvailability = null, rules = null) {
  const options = parseTableWork(args); const action = options.action;
  if (!action) throw new Error('table-work requires an action.');
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const dataWork = createDataWorkService({ stateDir, projectRoot, installationRoot, resourceControl });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const handoffRecovery = new RoundRecovery({ stateDir, registry });
  const handoffs = createHandoffService({ registry, rules, saveService, dataWork, roundRecovery: handoffRecovery, resourceControl });
  const tableModule = createTableWorkModule({
    dataWork, savedWork,
    resolveProject: (projectId) => tableWorkProject(registry, projectId),
    availability: moduleAvailability,
    handoffService: handoffs,
  });
  const invokeProject = (projectId, action, parameters = {}) => tableModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: projectId, action, parameters,
  });
  const invokeWork = (sessionId, action, parameters = {}, baseRevision = null) => {
    const current = dataWork.session(sessionId);
    if (!current) throw new Error('This Work Session is unavailable.');
    return tableModule.invoke({
      protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: current.project_id,
      work: { session_id: sessionId, base_revision: baseRevision ?? current.revision }, action, parameters,
    });
  };
  const sessionEntry = (sessionId) => {
    const initial = dataWork.session(sessionId);
    if (!initial) throw new Error('This Work Session is unavailable.');
    const entry = tableWorkProject(registry, initial.project_id);
    return { entry, session: initial };
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
      const result = await invokeProject(options.projectId, 'list', { limit: options.limit, offset: options.offset });
      emit('table-work.list', result.data, (data) => console.log(JSON.stringify(data, null, 2)));
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
      const started = await invokeProject(options.projectId, 'start', { resource_ids: resourceIds, return_state: { origin: { kind: 'host' } }, intent: options.intent, caller: callerFromOptions(options) });
      const session = started.data;
      emit('table-work.start', session, (value) => console.log(`Started ${value.session_id} with ${value.sources.length} Source(s).`)); return;
    }
    const sessionId = options.positional[0];
    if (!sessionId || options.positional.length !== 1) throw new Error(`table-work ${action} requires one session_id.`);
    const { entry } = sessionEntry(sessionId);
    if (action === 'show') {
      const shown = await invokeWork(sessionId, 'show');
      emit('table-work.show', shown.data, (value) => console.log(`${value.session_id}: ${value.sources.length} Source(s), Recipe v${value.recipe.version}.`)); return;
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
      const reused = await invokeWork(sessionId, 'reuse', { source_assignments: sourceAssignments, intent: options.intent, caller: callerFromOptions(options) }, requireBaseRevision());
      emit('table-work.reuse', reused.data, (value) => console.log(`Reused ${sessionId} as ${value.session_id}.`)); return;
    }
    if (action === 'reconcile') {
      const decisions = ['use-current', 'pin-recorded', 'follow-latest', 'stop-using'];
      if (!options.sourceKey || !decisions.includes(options.decision) || !options.tool || !options.clientRunId) {
        throw new Error('table-work reconcile requires --source-key, --decision <use-current|pin-recorded|follow-latest|stop-using>, --tool, and --client-run-id.');
      }
      const reconciled = await invokeWork(sessionId, 'reconcile', { source_key: options.sourceKey, decision: options.decision, caller: callerFromOptions(options) }, requireBaseRevision());
      emit('table-work.reconcile', reconciled.data, (value) => console.log(`Reconciled ${options.sourceKey} at Work revision ${value.revision}.`)); return;
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
      const reconciled = await invokeWork(sessionId, 'reconcile-batch', { source_keys: sourceKeys, decision: options.decision, caller: callerFromOptions(options) }, requireBaseRevision());
      emit('table-work.reconcile-batch', reconciled.data, (value) => console.log(`Reconciled ${sourceKeys.length} Sources at Work revision ${value.revision}.`)); return;
    }
    if (action === 'add-source') {
      if (options.sources.length !== 1) throw new Error('table-work add-source requires exactly one --source.');
      const identified = resourceControl.identify({ filePath: sourcePath(entry, options.sources[0]), project: entry.project });
      const added = await invokeWork(sessionId, 'add-source', { resource_id: identified.resource_id }, requireBaseRevision());
      emit('table-work.add-source', added.data, (value) => console.log(`Added Source; ${value.sources.length} selected.`)); return;
    }
    if (action === 'remove-source') {
      if (!options.resourceId) throw new Error('table-work remove-source requires --resource <resource_id>.');
      const removed = await invokeWork(sessionId, 'remove-source', { resource_id: options.resourceId }, requireBaseRevision());
      emit('table-work.remove-source', removed.data, (value) => console.log(`Removed Source; ${value.sources.length} selected.`)); return;
    }
    if (action === 'prepare') { const prepared = await invokeWork(sessionId, 'prepare', {}, requireBaseRevision()); emit('table-work.prepare', prepared.data, (value) => console.log(`Prepared ${value.sources.length} Source(s).`)); return; }
    if (action === 'sheet') {
      if (!options.sourceKey || !options.sheet) throw new Error('table-work sheet requires --source-key and --sheet.');
      const sheet = await invokeWork(sessionId, 'sheet', { source_key: options.sourceKey, sheet: options.sheet }, requireBaseRevision());
      emit('table-work.sheet', sheet.data, (value) => console.log(`Prepared Sheet for ${value.session_id}.`)); return;
    }
    if (action === 'align') {
      const request = readRequest(); const mapping = Array.isArray(request) ? request : request.mapping;
      const aligned = await invokeWork(sessionId, 'align', { mapping }, requireBaseRevision());
      emit('table-work.align', aligned.data, (value) => console.log(`Confirmed ${value.mapping.length} field alignment(s).`)); return;
    }
    if (action === 'recipe') { const recipe = await invokeWork(sessionId, 'recipe', { recipe: readRequest() }, requireBaseRevision()); emit('table-work.recipe', recipe.data, (value) => console.log(`Saved Recipe v${value.recipe.version}.`)); return; }
    if (action === 'preview') { const preview = await invokeWork(sessionId, 'preview', {}, requireBaseRevision()); emit('table-work.preview', preview.data, (value) => console.log(`Previewed Recipe v${value.recipe.version}.`)); return; }
    if (action === 'focus') {
      if (Boolean(options.clear) === (options.category != null) || !options.tool || !options.clientRunId) throw new Error('table-work focus requires exactly one of --category or --clear, plus --tool and --client-run-id.');
      if (Boolean(options.handoffId) !== Boolean(options.handoffDigest)) throw new Error('Handoff-bound focus requires both --handoff and --handoff-digest.');
      const focused = await invokeWork(sessionId, 'focus', { category: options.category, clear: options.clear, caller: callerFromOptions(options), ...(options.handoffId ? { handoff_id: options.handoffId, handoff_digest: options.handoffDigest } : {}) }, requireBaseRevision());
      emit('table-work.focus', focused.data, (value) => console.log(value.focus ? `Focused ${value.focus.field} = ${value.focus.value}; preview the new Work revision.` : 'Cleared category focus; preview the new Work revision.')); return;
    }
    if (action === 'details') {
      const details = await invokeWork(sessionId, 'details', { offset: options.offset ?? 0, limit: options.limit ?? 20 }, requireBaseRevision());
      emit('table-work.details', details.data, (value) => console.log(`${value.rows.length} processed input rows of ${value.total}; offset ${value.offset}.`)); return;
    }
    if (action === 'save') {
      if (!options.folder || !options.fileName || !['csv', 'xlsx'].includes(options.format) || !options.requestKey || !options.reason || !options.tool || !options.clientRunId) throw new Error('table-work save requires --folder, --file-name, --format <csv|xlsx>, --request-key, --reason, --tool, and --client-run-id.');
      const baseRevision = requireBaseRevision();
      const saved = await invokeWork(sessionId, 'save', {
        folder: options.folder,
        file_name: options.fileName,
        format: options.format,
        request_key: options.requestKey,
        reason: options.reason,
        caller: callerFromOptions(options),
      }, baseRevision);
      emit('table-work.save', saved.data, (value) => console.log(`Saved and verified ${value.work_id}.`)); return;
    }
    throw new Error(`Unknown table-work action: ${action}.`);
  } finally { handoffRecovery.dispose(); resourceControl.dispose(); }
}

async function handleHandoff(registry, saveService, rules, args) {
  const [action, ...rest] = args;
  const options = { positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--project') options.projectId = rest[++index];
    else if (token === '--request-file') options.requestFile = rest[++index];
    else if (token === '--limit') options.limit = Number(rest[++index]);
    else if (token.startsWith('--')) throw new Error(`Unknown handoff argument: ${token}`);
    else options.positional.push(token);
  }
  if (!options.projectId) throw new Error(`handoff ${action ?? '(missing)'} requires --project <project_id>.`);
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const dataWork = createDataWorkService({ stateDir, projectRoot, installationRoot, resourceControl });
  const roundRecovery = new RoundRecovery({ stateDir, registry });
  const service = createHandoffService({ registry, rules, saveService, dataWork, roundRecovery, resourceControl });
  try {
    if (action === 'create') {
      if (options.positional.length || !options.requestFile) throw new Error('handoff create requires --project and --request-file <json>.');
      const requestPath = path.resolve(options.requestFile);
      const stat = fs.lstatSync(requestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Handoff request must be a regular file no larger than 64 KiB.');
      const result = await service.create({ projectId: options.projectId, request: JSON.parse(fs.readFileSync(requestPath, 'utf8')) });
      emit('handoff.create', result, (data) => console.log(`${data.handoff_id}: ${data.status} · ${data.digest}`));
    } else if (action === 'list') {
      if (options.positional.length) throw new Error('handoff list does not accept an ID.');
      const result = service.list({ projectId: options.projectId, limit: options.limit ?? 20 });
      emit('handoff.list', result, (data) => console.log(`${data.handoffs.length} Handoff(s).`));
    } else if (action === 'show' || action === 'read') {
      if (options.positional.length !== 1) throw new Error(`handoff ${action} requires one handoff_id.`);
      const result = await service.read({ projectId: options.projectId, handoffId: options.positional[0] });
      emit(`handoff.${action}`, result, (data) => console.log(`${data.handoff_id}: ${data.status} · Work ${data.work_id} r${data.current_work_revision ?? data.work_revision}`));
    } else throw new Error('Use handoff create|list|show|read --project <project_id>.');
  } finally { roundRecovery.dispose(); resourceControl.dispose(); }
}

function handleModuleAvailability(moduleAvailability, args) {
  const [action, moduleId, ...rest] = args;
  if (action === 'list') {
    if (moduleId !== undefined || rest.length) throw new Error('module list does not accept arguments.');
    const modules = moduleAvailability.list();
    emit('module.availability.list', { modules }, (data) => {
      for (const item of data.modules) console.log(`${item.module_id}: ${item.enabled ? 'enabled' : 'disabled'} (revision ${item.revision})`);
    });
    return;
  }
  if (!['disable', 'enable'].includes(action) || !moduleId) throw new Error('Use module list or module disable|enable <module_id>.');
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--expected-revision') options.expectedRevision = Number(rest[++index]);
    else if (rest[index] === '--request-key') options.requestKey = rest[++index];
    else if (rest[index] === '--reason') options.reason = rest[++index];
    else throw new Error(`Unknown module ${action} argument: ${rest[index]}`);
  }
  const receipt = moduleAvailability.change({ moduleId, enabled: action === 'enable', ...options });
  emit(`module.${action}`, receipt, (data) => console.log(`${data.module_id}: ${data.enabled ? 'enabled' : 'disabled'} (revision ${data.revision})${data.replayed ? '; repeated request.' : ''}`));
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

function readDocumentBlockFile(filePath, label, maxBytes = 2048) {
  const absolute = path.resolve(filePath);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} cannot pass through a symbolic link or junction.`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes.`);
  const bytes = fs.readFileSync(absolute);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} must be no larger than ${maxBytes} UTF-8 bytes.`);
  return text;
}

function handleDocumentUpdate(service, args) {
  const [group, action, ...rest] = args;
  if (group === 'update' && action === 'batch') {
    const [batchAction, ...tokens] = rest; const options = {};
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (index === 0 && /^BUP-[a-f0-9]{32}$/u.test(token)) options.batchId = token;
      else if (token === '--project') options.projectId = tokens[++index];
      else if (token === '--request-file') options.requestFile = tokens[++index];
      else if (token === '--request-key') options.requestKey = tokens[++index];
      else if (token === '--expected-revision') options.expectedRevision = Number(tokens[++index]);
      else if (token === '--expected-digest') options.expectedDigest = tokens[++index];
      else if (token !== '--json') {
        const consumed = parseCallerFlag(options, tokens, index);
        if (consumed == null) throw new Error(`Unknown document update batch argument: ${token}`);
        index = consumed;
      }
    }
    if (!options.projectId) throw new Error('document update batch requires --project.');
    const caller = { tool: options.tool, client_run_id: options.clientRunId };
    let result;
    if (batchAction === 'show' && options.batchId) result = service.showBatch(options.batchId, options);
    else if (batchAction === 'prepare' && options.requestFile) {
      const request = JSON.parse(readDocumentBlockFile(options.requestFile, 'Batch selection', 64 * 1024));
      result = service.prepareBatch({ ...options, items: request.items, caller });
    } else if (batchAction === 'advance' && options.batchId) result = service.advanceBatch(options.batchId, { ...options, caller });
    else throw new Error('Use document update batch prepare --request-file, show BUP, or advance BUP with revision and digest.');
    emit(`document.update.batch.${batchAction}`, result, data => console.log(`${data.batch_id}: ${data.successful_count} applied; ${data.remaining_count} remaining; revision ${data.revision}.`));
    return;
  }
  if (group !== 'update') throw new Error('Use document update inspect, prepare, show, decide, execute, undo, or recover.');
  if (action === 'show') {
    const updateId = rest[0]; let projectId = null;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--project') projectId = rest[++index];
      else if (rest[index] !== '--json') throw new Error(`Unknown document update show argument: ${rest[index]}`);
    }
    if (!updateId || !projectId) throw new Error('document update show requires an UPD id and --project.');
    emit('document.update.show', service.show(updateId, { projectId }), (data) => console.log(`${data.update_id}: ${data.status}; revision ${data.revision}.`));
    return;
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (index === 0 && /^UPD-[a-f0-9]{32}$/u.test(token) && ['decide', 'execute', 'undo', 'recover'].includes(action)) options.updateId = token;
    else if (token === '--project') options.projectId = rest[++index];
    else if (token === '--resource') options.resourceId = rest[++index];
    else if (token === '--expected-sha256') options.expectedSha256 = rest[++index];
    else if (token === '--old-text-file') options.oldTextFile = rest[++index];
    else if (token === '--new-text-file') options.newTextFile = rest[++index];
    else if (token === '--source-save') options.sourceSaveId = rest[++index];
    else if (token === '--request-file') options.requestFile = rest[++index];
    else if (token === '--request-key') options.requestKey = rest[++index];
    else if (token === '--expected-revision') options.expectedRevision = Number(rest[++index]);
    else if (token === '--expected-current-sha256') options.expectedCurrentSha256 = rest[++index];
    else if (token === '--decision') options.decision = rest[++index];
    else if (token === '--text-file') options.textFile = rest[++index];
    else if (token === '--json') options.json = true;
    else {
      const consumed = parseCallerFlag(options, rest, index);
      if (consumed == null) throw new Error(`Unknown document update ${action} argument: ${token}`);
      index = consumed;
    }
  }
  if (!options.projectId || (['inspect', 'prepare'].includes(action) && !options.resourceId)) throw new Error(`document update ${action} requires --project and inspect/prepare also require --resource.`);
  if (options.requestFile && action !== 'prepare') throw new Error('--request-file is only supported by document update prepare.');
  if (action === 'inspect') {
    emit('document.update.inspect', service.inspect(options), (data) => console.log(`${data.resource_id}: ${data.baseline.sha256} (${data.baseline.bytes} bytes).`));
    return;
  }
  const caller = { tool: options.tool, client_run_id: options.clientRunId };
  if (!options.requestKey || !caller.tool || !caller.client_run_id) throw new Error(`document update ${action} requires --request-key, --tool, and --client-run-id.`);
  if (action === 'prepare') {
    if (options.requestFile) {
      if (!options.expectedSha256 || options.oldTextFile || options.newTextFile || options.sourceSaveId) throw new Error('Link repair prepare requires --expected-sha256 and --request-file; do not combine it with Capture Source or free text flags.');
      const request = JSON.parse(readDocumentBlockFile(options.requestFile, 'Link repair source and patch', 64 * 1024));
      if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !['source', 'patch'].includes(key))
        || !['project_move', 'project_membership'].includes(request.source?.kind) || request.patch?.kind !== 'link_repair') throw new Error('Link repair request must contain only a typed migration source and patch.kind="link_repair". Project, Resource, Hash and caller come from CLI flags.');
      const result = service.prepare({ projectId: options.projectId, resourceId: options.resourceId, expectedSha256: options.expectedSha256,
        source: request.source, patch: request.patch, requestKey: options.requestKey, caller });
      emit('document.update.prepare', result, data => console.log(`${data.update_id ?? data.resource_id}: ${data.status}; review supported link changes.`));
      return;
    }
    if (!options.expectedSha256 || !options.oldTextFile || !options.newTextFile || !options.sourceSaveId) {
      throw new Error('document update prepare requires --expected-sha256, --old-text-file, --new-text-file, and --source-save.');
    }
    const result = service.prepare({ ...options, oldText: readDocumentBlockFile(options.oldTextFile, 'Old text'),
      newText: readDocumentBlockFile(options.newTextFile, 'New text'), caller });
    emit('document.update.prepare', result, (data) => console.log(`${data.update_id}: ${data.status}; review the three text versions.`));
    return;
  }
  if (action === 'decide') {
    const updateId = options.updateId ?? rest.find((value) => value.startsWith('UPD-'));
    if (!updateId || !Number.isInteger(options.expectedRevision) || !options.expectedCurrentSha256 || !options.decision) {
      throw new Error('document update decide requires an UPD id, --expected-revision, --expected-current-sha256, and --decision.');
    }
    const text = options.textFile ? readDocumentBlockFile(options.textFile, 'Revised text') : '';
    const result = service.decide(updateId, { ...options, text, caller });
    emit('document.update.decide', result, (data) => console.log(`${data.update_id}: suggestion ${data.decision?.kind ?? 'recorded'}; revision ${data.revision}.`));
    return;
  }
  if (['execute', 'undo', 'recover'].includes(action)) {
    if (!options.updateId || !Number.isInteger(options.expectedRevision) || !options.expectedCurrentSha256) {
      throw new Error(`document update ${action} requires an UPD id, --expected-revision and --expected-current-sha256.`);
    }
    const result = service[action](options.updateId, { ...options, caller });
    emit(`document.update.${action}`, result, (data) => console.log(`${data.update_id}: ${data.status}; revision ${data.revision}.`));
    return;
  }
  throw new Error(`Unknown document update action: ${action ?? '(missing)'}`);
}

async function handleCapture(capture, captureSourceModule, args) {
  const [action, ...rest] = args;
  if (action === 'source') {
    const [sourceAction, ...sourceArgs] = rest;
    if (sourceAction === 'prepare') {
      const options = {};
      for (let index = 0; index < sourceArgs.length; index += 1) {
        const token = sourceArgs[index];
        if (token === '--url') options.url = sourceArgs[++index];
        else if (token === '--project') options.projectId = sourceArgs[++index];
        else if (token === '--folder') options.folder = sourceArgs[++index];
        else if (token === '--name') options.name = sourceArgs[++index];
        else if (token === '--request-key') options.requestKey = sourceArgs[++index];
        else {
          const consumed = parseCallerFlag(options, sourceArgs, index);
          if (consumed == null) throw new Error(`Unknown capture source prepare argument: ${token}`);
          index = consumed;
        }
      }
      if (!options.url || !options.projectId || !options.folder || !options.name || !options.requestKey || !options.tool || !options.clientRunId) {
        throw new Error('capture source prepare requires --url, --project, --folder, --name, --request-key, --tool, and --client-run-id.');
      }
      const envelope = await captureSourceModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source',
        project_id: options.projectId, action: 'capture-url', parameters: { ...options, caller: { tool: options.tool, client_run_id: options.clientRunId } } });
      const receipt = envelope.data;
      emit('capture.source.prepare', receipt, (data) => console.log(data.status === 'export_required'
        ? data.reason : `${data.status}: ${data.save_id} (${data.version_id}).`));
      return;
    }
    if (sourceAction === 'inspect-export') {
      const options = {};
      for (let index = 0; index < sourceArgs.length; index += 1) {
        const token = sourceArgs[index];
        if (token === '--input') options.inputPath = sourceArgs[++index];
        else if (token === '--limit') options.limit = Number(sourceArgs[++index]);
        else if (token === '--cursor') options.cursor = sourceArgs[++index];
        else if (token === '--json') options.json = true;
        else throw new Error(`Unknown capture source inspect-export argument: ${token}`);
      }
      if (!options.inputPath) throw new Error('capture source inspect-export requires --input.');
      const envelope = await captureSourceModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source',
        project_id: null, action: 'inspect-export', parameters: options });
      const receipt = envelope.data;
      emit('capture.source.inspect_export', receipt, (data) => console.log(`${data.items.length} conversation(s) inspected${data.has_more ? '; more available.' : '.'}`));
      return;
    }
    if (sourceAction === 'prepare-export') {
      const options = {};
      for (let index = 0; index < sourceArgs.length; index += 1) {
        const token = sourceArgs[index];
        if (token === '--input') options.inputPath = sourceArgs[++index];
        else if (token === '--expected-input-sha256') options.expectedInputSha256 = sourceArgs[++index];
        else if (token === '--selection') options.selectionToken = sourceArgs[++index];
        else if (token === '--project') options.projectId = sourceArgs[++index];
        else if (token === '--folder') options.folder = sourceArgs[++index];
        else if (token === '--name') options.name = sourceArgs[++index];
        else if (token === '--request-key') options.requestKey = sourceArgs[++index];
        else if (token === '--json') options.json = true;
        else {
          const consumed = parseCallerFlag(options, sourceArgs, index);
          if (consumed == null) throw new Error(`Unknown capture source prepare-export argument: ${token}`);
          index = consumed;
        }
      }
      const match = String(options.selectionToken ?? '').match(/^(0|[1-9]\d*):([a-f0-9]{64})$/u);
      if (match) options.selection = { index: Number(match[1]), selected_sha256: match[2] };
      if (!options.inputPath || !/^[a-f0-9]{64}$/u.test(options.expectedInputSha256 ?? '') || !options.selection
          || !options.projectId || !options.folder || !options.name || !options.requestKey || !options.tool || !options.clientRunId) {
        throw new Error('capture source prepare-export requires --input, --expected-input-sha256, --selection, --project, --folder, --name, --request-key, --tool, and --client-run-id.');
      }
      const envelope = await captureSourceModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source',
        project_id: options.projectId, action: 'prepare-export', parameters: { ...options, caller: { tool: options.tool, client_run_id: options.clientRunId } } });
      const receipt = envelope.data;
      emit('capture.source.prepare_export', receipt, (data) => console.log(`${data.status}: ${data.save_id} (${data.version_id}).`));
      return;
    }
    if (sourceAction === 'show' || sourceAction === 'read') {
      const saveId = sourceArgs[0];
      if (!saveId || saveId.startsWith('--')) throw new Error(`capture source ${sourceAction} requires one save_id`);
      const options = {};
      for (let index = 1; index < sourceArgs.length; index += 1) {
        if (sourceArgs[index] === '--project') options.projectId = sourceArgs[++index];
        else if (sourceArgs[index] === '--cursor') options.cursor = sourceArgs[++index];
        else if (sourceArgs[index] === '--characters') options.characters = Number(sourceArgs[++index]);
        else if (sourceAction === 'read' && sourceArgs[index] === '--mode') options.mode = sourceArgs[++index];
        else throw new Error(`Unknown capture source ${sourceAction} argument: ${sourceArgs[index]}`);
      }
      if (!options.projectId) throw new Error(`capture source ${sourceAction} requires --project.`);
      const envelope = await captureSourceModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source',
        project_id: options.projectId, action: sourceAction, parameters: { ...options, saveId } });
      const receipt = envelope.data;
      emit(`capture.source.${sourceAction}`, receipt, (data) => console.log(sourceAction === 'read' ? data.excerpt : `${data.save_id}: ${data.status}; ${data.version_id}.`));
      return;
    }
    throw new Error(`Unknown capture source action: ${sourceAction ?? '(missing)'}`);
  }
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
  if (action === 'row') {
    const options = { action };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--resource') options.resourceId = rest[++index];
      else if (rest[index] === '--sheet') options.sheet = rest[++index];
      else if (rest[index] === '--row') options.row = Number(rest[++index]);
      else if (rest[index] === '--key-column') options.keyColumn = rest[++index];
      else if (rest[index] === '--key-value') options.keyValue = rest[++index];
      else if (rest[index] !== '--json') throw new Error(`Unknown content row argument: ${rest[index]}`);
    }
    const hasKey = options.keyColumn != null || options.keyValue != null;
    if (!options.projectId || !options.resourceId
      || (options.row != null) === hasKey
      || (options.keyColumn == null) !== (options.keyValue == null)) {
      throw new Error('content row requires --project and --resource, plus --sheet with --row or --key-column with --key-value.');
    }
    if (options.row != null && !options.sheet) throw new Error('content row with --row requires --sheet.');
    if (options.keyColumn != null) options.key = { column: options.keyColumn, value: options.keyValue };
    return options;
  }
  if (action === 'locate') {
    const options = { action, limit: 50 };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--resource') options.resourceId = rest[++index];
      else if (rest[index] === '--limit') options.limit = Number(rest[++index]);
      else if (rest[index] === '--sheet') options.sheet = rest[++index];
      else if (rest[index] === '--cell') options.cell = rest[++index];
      else if (rest[index] === '--page') options.page = Number(rest[++index]);
      else if (rest[index] === '--cursor') options.cursor = rest[++index];
      else if (rest[index] === '--tables') options.tables = true;
      else if (rest[index] === '--table-index') options.tableIndex = Number(rest[++index]);
      else if (rest[index] === '--x') options.x = Number(rest[++index]);
      else if (rest[index] === '--y') options.y = Number(rest[++index]);
      else if (rest[index] === '--width') options.width = Number(rest[++index]);
      else if (rest[index] === '--height') options.height = Number(rest[++index]);
      else if (rest[index] !== '--json') throw new Error(`Unknown content locate argument: ${rest[index]}`);
    }
    if (!options.projectId || !options.resourceId) throw new Error('content locate requires --project and --resource.');
    return options;
  }
  if (action === 'read-ref') {
    const options = { action };
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--project') options.projectId = rest[++index];
      else if (rest[index] === '--ref') options.ref = rest[++index];
      else if (rest[index] !== '--json') throw new Error(`Unknown content read-ref argument: ${rest[index]}`);
    }
    if (!options.projectId || !options.ref) throw new Error('content read-ref requires --project and --ref.');
    return options;
  }
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
      else if (rest[index] === '--details') options.details = true;
      else if (rest[index] === '--key-column') options.keyColumn = rest[++index];
      else if (rest[index] === '--period-column') options.periodColumn = rest[++index];
      else if (rest[index] === '--event-date-column') options.eventDateColumn = rest[++index];
      else if (rest[index] === '--left-sheet') options.leftSheet = rest[++index];
      else if (rest[index] === '--right-sheet') options.rightSheet = rest[++index];
      else throw new Error(`Unknown content compare argument: ${rest[index]}`);
    }
    if (!options.leftPath || !options.rightPath) {
      throw new Error('content compare requires --left <path> and --right <path>');
    }
    if (!options.details && (options.keyColumn || options.periodColumn || options.eventDateColumn)) {
      throw new Error('content compare column options require --details.');
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
  const moduleAvailability = createModuleAvailabilityService({ stateDir });

  if (command === 'module') {
    const [moduleAction, moduleId, ...rest] = args;
    const local = createLocalModuleService({ stateDir });
    const values = (tokens, allowed) => {
      const result = {};
      for (let index = 0; index < tokens.length; index += 1) {
        const key = tokens[index];
        if (!allowed.includes(key)) throw new Error(`Unknown module ${moduleAction} argument: ${key}`);
        result[key.slice(2).replaceAll('-', '_')] = tokens[++index];
      }
      return result;
    };
    if (moduleAction === 'package-preview') {
      const options = values(args.slice(1), ['--file']);
      if (!options.file) throw new Error('module package-preview requires --file <path>.');
      const preview = local.previewPackage({ filePath: options.file });
      emit('module.package-preview', preview, (data) => console.log(`${data.module_id}@${data.module_version} · SHA-256 ${data.sha256} · permission ${data.permissions.join(', ')} · code not executed.`));
      return;
    }
    if (moduleAction === 'install') {
      const options = values(args.slice(1), ['--file', '--expected-sha256', '--expected-revision', '--request-key']);
      const receipt = local.install({ filePath: options.file, expectedSha256: options.expected_sha256, expectedRevision: Number(options.expected_revision), requestKey: options.request_key });
      emit('module.install', receipt, (data) => console.log(`${data.module_id}@${data.module_version}: installed disabled (revision ${data.revision}).`));
      return;
    }
    if (moduleAction === 'package-list') {
      emit('module.package-list', { packages: local.list(), revision: local.revision() }, (data) => console.log(JSON.stringify(data, null, 2)));
      return;
    }
    if (['enable', 'disable'].includes(moduleAction) && moduleId?.startsWith('local.')) {
      const options = values(rest, ['--expected-revision', '--request-key']);
      const receipt = local.setEnabled({ moduleId, enabled: moduleAction === 'enable', expectedRevision: Number(options.expected_revision), requestKey: options.request_key });
      emit(`module.${moduleAction}`, receipt, (data) => console.log(`${data.module_id}: ${data.enabled ? 'enabled' : 'disabled'} (revision ${data.revision}).`));
      return;
    }
    if (moduleAction === 'preview' || moduleAction === 'save') {
      const options = values(rest, ['--project', '--resource', '--target', '--request-key', '--tool', '--client-run-id']);
      const projectId = options.project;
      if (!moduleId || !projectId || !options.resource) throw new Error(`module ${moduleAction} requires <module_id> --project <id> --resource <id>.`);
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
      const intakeForLocal = new Intake({ stateDir });
      const saveForLocal = new SaveService({ stateDir, intake: intakeForLocal, resourceControl: control });
      const runner = createLocalModuleService({ stateDir, registry, resourceControl: control, saveService: saveForLocal });
      try {
        if (moduleAction === 'preview') {
          const data = await runner.previewTransform({ moduleId, projectId, resourceId: options.resource });
          emit('module.preview', data, (value) => console.log(`${value.module_id}@${value.module_version}: ${value.output_text}`));
        } else {
          if (!options.target || !options.request_key || !options.tool || !options.client_run_id) throw new Error('module save requires --target, --request-key, --tool, and --client-run-id.');
          const data = await runner.prepareSave({ moduleId, projectId, resourceId: options.resource, target: options.target, requestKey: options.request_key, caller: { tool: options.tool, client_run_id: options.client_run_id } });
          emit('module.save', { ...data, review: saveForLocal.review(data.save_id) }, (value) => console.log(`Prepared ${value.save_id}; review and execute through atlas save.`));
        }
      } finally { control.dispose(); registry.dispose(); intakeForLocal.dispose(); }
      return;
    }
    handleModuleAvailability(moduleAvailability, args);
    return;
  }

  if (command === 'resource') {
    const [area, action, ...rest] = args;
    if (area === 'show') {
      const resourceId = action;
      let projectId = null;
      let relationDepth = null;
      let relationStatus = null;
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--project') projectId = rest[++index];
        else if (rest[index] === '--relation-depth') relationDepth = Number(rest[++index]);
        else if (rest[index] === '--relation-status') relationStatus = rest[++index];
        else throw new Error(`Unknown resource show argument: ${rest[index]}`);
      }
      if (!resourceId || !projectId) throw new Error('resource show requires a resource_id and --project');
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
      try {
        const entry = tableWorkProject(registry, projectId);
        const resource = control.projectResource(projectId, resourceId, { refresh: true });
        const dataWork = createDataWorkService({ stateDir, projectRoot, installationRoot, resourceControl: control });
        const workSessions = dataWork.openProjectSessions(entry.project);
        const savedWork = createSavedWorkService({ stateDir }).listForProject(projectId);
        const boardService = createBoardService({ stateDir, registry, resourceControl: control, projectRoot, installationRoot });
        try {
        const relationshipFocus = relationDepth != null || relationStatus != null
          ? control.relationshipFocus(projectId, resourceId, { depth: relationDepth ?? 1, status: relationStatus ?? 'active' }) : undefined;
        const impactLanes = buildResourceImpactLanes({ resource, workSessions, savedWork });
        const resourceFocusGraph = relationshipFocus ? buildResourceFocusGraph({ projectId, resource, relationshipFocus, impactLanes }) : undefined;
        emit('resource.show', {
            ...resource,
            linked_relationships: control.linkedResourceRelationships(projectId, resourceId),
          ...(relationshipFocus ? { relationship_focus: relationshipFocus } : {}),
          ...(resourceFocusGraph ? { resource_focus_graph: resourceFocusGraph } : {}),
            impact_lanes: impactLanes,
            board_references: boardService.listResourceReferences(projectId, resourceId),
          }, (data) => console.log(JSON.stringify(data, null, 2)));
        } finally { boardService.dispose(); }
      } finally { control.dispose(); registry.dispose(); }
      return;
    }
    if (area === 'relink' && ['preview', 'confirm'].includes(action)) {
      let requestFile = null; let previewDigest = null; let requestKey = null; let tool = null; let clientRunId = null;
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--request-file') requestFile = rest[++index];
        else if (rest[index] === '--preview-digest') previewDigest = rest[++index];
        else if (rest[index] === '--request-key') requestKey = rest[++index];
        else if (rest[index] === '--tool') tool = rest[++index];
        else if (rest[index] === '--client-run-id') clientRunId = rest[++index];
        else throw new Error(`Unknown resource relink argument: ${rest[index]}`);
      }
      if (!requestFile) throw new Error(`resource relink ${action} requires --request-file <json>.`);
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      if (!request.project_id || !request.resource_id || !request.file_path) throw new Error('Resource relink request requires project_id, resource_id, and file_path.');
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
      try {
        if (action === 'preview') {
          emit('resource.relink.preview', control.previewProjectRelink({ projectId: request.project_id, resourceId: request.resource_id, filePath: request.file_path }), (value) => console.log(JSON.stringify(value, null, 2)));
        } else {
          if (!previewDigest || !requestKey || !tool || !clientRunId) throw new Error('resource relink confirm requires --preview-digest, --request-key, --tool, and --client-run-id.');
          emit('resource.relink.confirm', control.confirmProjectRelink({ projectId: request.project_id, resourceId: request.resource_id, filePath: request.file_path, previewDigest, requestKey, caller: { tool, client_run_id: clientRunId } }), (value) => console.log(JSON.stringify(value, null, 2)));
        }
      } finally { control.dispose(); registry.dispose(); }
      return;
    }
    if (area === 'relationships' && ['suggest','suggestions','suggestion'].includes(action)) {
      let requestFile=null; let requestKey=null; let tool=null; let clientRunId=null; let projectId=null; let candidateId=null;
      for(let index=0;index<rest.length;index+=1){if(rest[index]==='--request-file')requestFile=rest[++index];else if(rest[index]==='--request-key')requestKey=rest[++index];else if(rest[index]==='--tool')tool=rest[++index];else if(rest[index]==='--client-run-id')clientRunId=rest[++index];else if(rest[index]==='--project')projectId=rest[++index];else if(rest[index]==='--candidate')candidateId=rest[++index];else throw new Error(`Unknown resource relationships ${action} argument: ${rest[index]}`);}
      const registry=new Registry({stateDir}); const control=createResourceControl({stateDir,ledger:registry.ledger,registry});
      try {
        if(action==='suggest'){
          if(!requestFile||!requestKey||!tool||!clientRunId)throw new Error('resource relationships suggest requires --request-file, --request-key, --tool, and --client-run-id.');
          const candidate=JSON.parse(fs.readFileSync(requestFile,'utf8'));
          emit('resource.relationships.suggest',{...control.suggestLinkedResource({candidate,requestKey,caller:{tool,client_run_id:clientRunId}})},(data)=>console.log(JSON.stringify(data,null,2)));
        }else{
          if(!projectId)throw new Error(`resource relationships ${action} requires --project.`);
          if(action==='suggestions')emit('resource.relationships.suggestions',{suggestions:control.listLinkedResourceSuggestions(projectId)},(data)=>console.log(JSON.stringify(data,null,2)));
          else {if(!candidateId)throw new Error('resource relationships suggestion requires --candidate.');emit('resource.relationships.suggestion',control.linkedResourceSuggestion(projectId,candidateId),(data)=>console.log(JSON.stringify(data,null,2)));}
        }
      }finally{control.dispose();registry.dispose();}
      return;
    }
    if (area !== 'relationships' || !['preview','submit'].includes(action)) throw new Error('Use atlas resource show or resource relationships preview/submit/suggest/suggestions/suggestion.');
    let requestFile = null; let tool = null; let clientRunId = null; let confirmPreview = null; let requestKey = null;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--request-file') requestFile = rest[++index];
      else if (rest[index] === '--tool') tool = rest[++index];
      else if (rest[index] === '--client-run-id') clientRunId = rest[++index];
      else if (rest[index] === '--confirm-preview') confirmPreview = rest[++index];
      else if (rest[index] === '--request-key') requestKey = rest[++index];
      else throw new Error(`Unknown resource relationships argument: ${rest[index]}`);
    }
    if (!requestFile) throw new Error(`resource relationships ${action} requires --request-file <json>.`);
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    const linkedResourceRequest = candidates.some((candidate) => candidate?.target?.kind === 'resource' || candidate?.type === 'linked_to');
    if (action === 'preview' || linkedResourceRequest) {
      if (candidates.length !== 1) throw new Error('Resource link preview/submit accepts exactly one candidate.');
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
      try {
        if (action === 'preview') {
          const preview = control.previewLinkedResource({ operation: request.operation, candidate: candidates[0], decisionChannel: 'host_command' });
          emit('resource.relationships.preview', preview, (data) => console.log(JSON.stringify(data, null, 2)));
        } else {
          if (!confirmPreview || !requestKey || !tool || !clientRunId) throw new Error('Resource link submit requires --confirm-preview, --request-key, --tool, and --client-run-id.');
          const receipt = control.submitLinkedResource({ operation: request.operation, candidate: candidates[0], previewToken: confirmPreview, requestKey, caller: { tool, client_run_id: clientRunId }, decisionChannel: 'host_command' });
          emit('resource.relationships.submit', receipt, (data) => console.log(JSON.stringify(data, null, 2)));
        }
      } finally { control.dispose(); registry.dispose(); }
      return;
    }
    if (action !== 'submit') throw new Error('Project relationship changes use resource relationships submit.');
    const control = createResourceControl({ stateDir });
    try { emit('resource.relationships.submit', { relationships: control.submitRelationships({ candidates: request.candidates, caller: { tool, client_run_id: clientRunId } }) }, (data) => console.log(JSON.stringify(data, null, 2))); }
    finally { control.dispose(); }
    return;
  }
  if (command === 'view') {
    const service = createProjectViewService({ stateDir, installationRoot });
    try { handleProjectViews(service, args); }
    finally { service.dispose(); }
    return;
  }

  if (command === 'content') {
    const options = parseContent(args);
    if (options.action === 'locate' || options.action === 'read-ref' || options.action === 'row') {
      const registry = new Registry({ stateDir });
      const control = createResourceControl({ stateDir, ledger: registry.ledger });
      const locations = createContentLocationService({ registry, resourceControl: control, installationRoot });
      try {
        if (options.action === 'row') {
          const data = locations.locateRow(options);
          emit('content.row', data, (value) => console.log(value.format === 'csv'
            ? `${value.resource_id} CSV record ${value.record_number}; ${value.row_sha256}.`
            : `${value.resource_id} ${value.sheet}!${value.row}; ${value.row_sha256}.`));
          return;
        }
        const data = options.action === 'locate' ? locations.locate(options) : locations.readRef(options);
        emit(`content.${options.action.replaceAll('-', '_')}`, data, (value) => console.log(options.action === 'locate'
          ? value.location_kind === 'pdf_region'
            ? `PDF region ${value.bbox?.join(',')}; ${value.status}; ${value.file.sha256}.`
            : value.location_kind === 'pdf_tables' || value.location_kind === 'pdf_table'
              ? `${value.tables?.length ?? value.cells?.length ?? 0} PDF ${value.location_kind === 'pdf_tables' ? 'table(s)' : 'cell(s)'}; ${value.status}; ${value.file.sha256}.`
              : value.start_codepoint !== undefined
            ? `PDF page ${value.page}, text codepoints ${value.start_codepoint}-${value.end_codepoint}; ${value.status}; ${value.file.sha256}.`
            : value.format === 'png'
            ? `${value.image.width}×${value.image.height} PNG; ${value.region ? `region ${value.region.x},${value.region.y} ${value.region.width}×${value.region.height}` : 'no region selected'}; ${value.file.sha256}.`
            : value.format === 'xlsx'
            ? `${value.sheets?.length ?? value.cells?.length ?? 0} ${value.sheets ? 'worksheet(s)' : `cell(s) in ${value.selected_sheet?.name ?? ''}`} for ${value.resource_id}; ${value.file.sha256}.`
            : `${value.pages?.length ?? value.items?.length ?? 0} exact page/section reference(s) for ${value.resource_id}; ${value.file.sha256}.`
          : value.format === 'pdf' && value.location_kind === 'pdf_region'
            ? `${value.status}: ${value.resource_id} page ${value.page} region ${value.bbox?.join(',')}${value.text == null ? ' (no text)' : ''}.`
            : value.format === 'pdf' && value.location_kind === 'pdf_table_cell'
              ? `${value.status}: ${value.resource_id} page ${value.page} table ${value.table_index} row ${value.row} column ${value.column}${value.text == null ? ' (no text)' : ` = ${value.text}`}.`
              : value.format === 'pdf' && value.start_codepoint !== undefined
            ? `${value.status}: ${value.resource_id} page ${value.page}, text codepoints ${value.start_codepoint}-${value.end_codepoint}${value.text == null ? ' (no text)' : ''}.`
            : value.format === 'pdf'
            ? `${value.status}: ${value.resource_id} page ${value.page}${value.text == null ? ' (no text)' : ''}.`
            : value.format === 'png'
              ? `${value.status}: ${value.resource_id}${value.region ? ` region ${value.region.x},${value.region.y} ${value.region.width}×${value.region.height}` : ''}.`
              : value.format === 'xlsx'
              ? `${value.status}: ${value.resource_id} ${value.sheet}!${value.cell}${value.value == null ? ` (${value.cell_status})` : ` = ${value.value}`}.`
              : `${value.status}: ${value.resource_id} lines ${value.start_line}-${value.end_line}.`));
      } finally { locations.dispose(); control.dispose(); registry.dispose(); }
      return;
    }
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
  const intake = new Intake({ stateDir });
  const save = new SaveService({ stateDir, intake });
  const portfolio = new Portfolio({ stateDir });
  const registry = new Registry({ stateDir });
  const evolution = new Evolution({ stateDir, registry, saveService: save });
  const catalog = new Catalog({ stateDir, registry });
  const storage = new RuntimeStorage({ stateDir, ledger: tracker.ledger });
  const capture = new BrowserCapture({ stateDir, storage });
  const captureSource = createCaptureSourceService({ stateDir, registry, saveService: save });
  const captureSourceModule = createCaptureSourceModule({ captureSource, availability: moduleAvailability });
  const documentResourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const documentUpdate = createDocumentUpdateService({ stateDir, registry, resourceControl: documentResourceControl, saveService: save });
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
      handleSave(save, evolution, registry, args);
    } else if (command === 'table-work') {
      await handleTableWork(registry, save, args, moduleAvailability, rules);
    } else if (command === 'handoff') {
      await handleHandoff(registry, save, rules, args);
    } else if (command === 'board') {
      await handleBoard(registry, save, args);
    } else if (command === 'round') {
      handleRound(registry, args);
    } else if (command === 'evolve') {
      handleEvolution(evolution, args);
    } else if (command === 'work') {
      handleWork(storage, args);
    } else if (command === 'capture') {
      await handleCapture(capture, captureSourceModule, args);
    } else if (command === 'document') {
      handleDocumentUpdate(documentUpdate, args);
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
    documentResourceControl.dispose();
    registry.dispose();
    catalog.dispose();
    rules.dispose();
    captureSource.dispose();
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
