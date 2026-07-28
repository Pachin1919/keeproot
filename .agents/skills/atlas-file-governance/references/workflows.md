# Atlas Workflow Commands

Replace placeholders without changing the order. Pass absolute paths where ambiguity is possible. Keep Candidate and state files inside the installed Atlas state root.

Define the CLI path in PowerShell without changing global environment configuration:

```powershell
$located = & '<USER_SKILL_ROOT>\scripts\locate-atlas.ps1' | ConvertFrom-Json
# Require status=ready, then invoke $located.node_path with node_args, $located.cli_path, and --json.
$env:ATLAS_HOME = $located.install_root
$env:ATLAS_STATE_DIR = $located.state_path
```

## Browser Capture → Intake

The browser-side helper is called from the controlled browser's local Node session, not by copying page text into the conversation:

```javascript
const { captureBrowserPage } = await import("<SKILL_ROOT>/scripts/capture-browser-page.mjs");
const captured = await captureBrowserPage({
  tab,
  stateDir: "<ATLAS_STATE_DIR>",
  mode: "selection"
});
```

Then use the installed Runtime:

```powershell
& $located.node_path @($located.node_args) $located.cli_path capture localize `
  --input-file $captured.capture_file --json

& $located.node_path @($located.node_args) $located.cli_path capture sample <work_id> `
  --start-character 0 --characters 1200 --json

& $located.node_path @($located.node_args) $located.cli_path intake prepare `
  --root <AUTHORIZED_ROOT> --candidate-file <candidate_path> --origin download `
  --kind source --project <project_id> --target <new_path> `
  --actor agent --agent <agent> --model <model> --tool <tool> --client-run-id <task_id> --json
```

Do not request a full DOM snapshot or emit the localized body. Stop after two failed capture attempts. A successful Intake execute is verified from its compact receipt and target Hash; do not call `intake show` unless reconciliation or explicit audit is required.

## Workspace Inspect

```powershell
& $atlasCli inspect --root '<AUTHORIZED_PROJECT_OR_LIBRARY>' --max-depth 6 --json
```

Use this for a known root before project cleanup or a split/move proposal. Require `source_changes: []`. Show only the relevant role hints, invalid Git markers, missing absolute paths, manifests, Skills and verification commands. The Agent reads the smallest necessary files from `recommended_agent_reads` and supplies the semantic judgment. A root nested inside an Obsidian Vault inherits `root_control_files_only`; ordinary Markdown bodies remain unread. Inspect does not approve or execute a change.

## Multi-root Portfolio

```powershell
& $atlasCli portfolio inventory --root '<AUTHORIZED_DISK_OR_WORKSPACE>' --depth 1 --exclude '<EXACT_BACKUP_ROOT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli portfolio show '<INVENTORY_ID>' --json
# Expand only selected work containers returned by depth 1; never expand software/cache/runtime/unknown roots automatically.
& $atlasCli portfolio inventory --root '<AUTHORIZED_DISK_OR_WORKSPACE>' --depth 2 --expand '<SELECTED_CONTAINER>' --exclude '<EXACT_BACKUP_ROOT>' --new --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli portfolio review '<INVENTORY_ID>' --root-id '<ROOT_ID>' --type '<ROOT_TYPE>' --relation '<RELATION>' --reason '<USER_REASON>' --json
& $atlasCli portfolio plan '<INVENTORY_ID>' --target '<TARGET_WORKSPACE>' --json
```

Require zero content reads and inspect `truncated`, `access_errors`, special paths, evidence, and candidate types. Review only facts the user can confirm. A Plan always has `source_changes: []`; it may propose target categories, but all cross-root actions remain blocked until a separate dependency report and supported governed migration are approved.

## Bootstrap

```powershell
& $atlasCli bootstrap scan --root '<AUTHORIZED_ROOT>' --ignore '<RELATIVE_INTERNAL_DIR>' --scan-mode structure --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli bootstrap profiles --json
& $atlasCli bootstrap context '<SCAN_ID>' --max-samples 5 --json
# Use Agent reasoning over this bounded context only if deterministic mapping remains materially unresolved.
& $atlasCli bootstrap propose '<SCAN_ID>' --proposal-file '<ATLAS_STATE_PROPOSAL_JSON>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli bootstrap contract '<SCAN_ID>' --profile '<PROFILE_ID>' --json
# Present this one Contract. Pause only for its questions or the user's approval of the exact contract_id.
& $atlasCli bootstrap adopt '<SCAN_ID>' --contract '<CONTRACT_ID>' --profile '<PROFILE_ID>' --reason '<USER_REASON>' --json
& $atlasCli bootstrap show '<SCAN_ID>' --json
```

Structure mode is the first-pass default for Agent workflows even though the CLI retains `metadata` as its compatibility default. It opens no target file content and does not calculate content hashes. Present `contract.review_card`, not the raw Contract: render `directory_map` as `path → kind → note`, summarize `technical_exclusions` in one line, show suggested additions/adjustments, and ask at most three questions. If `quality.status` is `needs_refinement`, resolve its unclassified directories or loose root files before requesting adoption. Put technical IDs, evidence, confidence, full zones, and full routes in an appendix or reveal them on request; omit `--profile` to use Atlas's deterministic recommendation. Use `--scan-mode metadata` only after explicit authorization for hashing all non-ignored files and reading Markdown metadata. Proposal JSON is either an array or `{ "predictions": [...] }`; every item needs `kind`, `summary`, `confidence`, `risk`, `affected_paths`, `evidence`, and `proposed_action`. If an advanced Agent Prediction must be active in the same RuleVersion, review that specific Prediction before adoption; unreviewed extras are deferred. Do not add an ignore or affected path that escapes the scan root. After adoption, use `bootstrap scan ... --new` for a corrected Contract version.

Treat names as environment-specific presentation, not universal English schema. From structure-only evidence, summarize the dominant script/language, numeric prefixes, separators, date styles, casing, and recurring role terms. Reuse accepted Chinese or other local names in recommendations. If the Runtime does not advertise persisted Naming Policy support, keep this as a reviewable Prediction and report the gap; do not claim it was learned or rename existing paths automatically.

Compatibility commands `bootstrap recommend`, `bootstrap review`, and `bootstrap initialize` remain available for detailed engineering workflows. The Skill should prefer `contract → adopt` so ordinary users do not review every underlying Prediction.

## Effective Preference Rules

Write the current task dimensions to a small Atlas-state JSON file:

```json
{
  "operation": "content_task",
  "project_id": "<PROJECT_ID>",
  "artifact_role": "report",
  "data_class": "temporal_snapshot",
  "target_path": "<PROJECT_RELATIVE_TARGET>",
  "needs": ["content_versioning"]
}
```

```powershell
& $atlasCli rule context --root '<AUTHORIZED_ROOT>' --request-file '<ATLAS_STATE_CONTEXT_JSON>' --json
& $atlasCli rule propose --root '<AUTHORIZED_ROOT>' --proposal-file '<ATLAS_STATE_PROPOSAL_JSON>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli rule preview '<RULE_CHANGE_ID>' --json
# After the user reviews the exact current/candidate values, scope, and impact:
& $atlasCli rule approve '<RULE_CHANGE_ID>' --reason '<USER_REASON>' --json
# Or close it without activation:
& $atlasCli rule reject '<RULE_CHANGE_ID>' --reason '<USER_REASON>' --json
& $atlasCli rule active --root '<AUTHORIZED_ROOT>' --json
```

For observed learning, proposal evidence contains existing paths inside the authorized root and short facts interpreted by the Agent. For an Atlas default, use `basis=default`, the exact returned `default_id`, and the exact default value. Do not claim that a default was learned from the user. Normal tasks read `rule context`, not `rule history`.

## Unified Intake

For one exact attached local file whose Project, new target, intent, and current-task authorization are already known, prefer the bundled compact wrapper:

```powershell
& '<SKILL_ROOT>\scripts\intake-attached-file.ps1' `
  -CandidateFile '<ATTACHMENT_OUTSIDE_ROOT>' -Root '<AUTHORIZED_ROOT>' `
  -Target '<EXACT_NEW_TARGET>' -Origin human_submitted -Kind source `
  -ProjectId '<STABLE_PROJECT_ID>' -Intent '<INTENT>' -Reason '<USER_AUTHORIZATION>' `
  -Agent '<AGENT>' -Model '<MODEL>' -Tool '<TOOL>' -ClientRunId '<TASK_ID>'
```

If the Agent has proved that the Project is not registered, replace `-ProjectId` with `-ProjectName '<NAME>' -ProjectPath '<RELATIVE_PATH>' -CreateProjectIfMissing`. The script accepts spaced and non-ASCII paths, performs the Runtime handshake and exact Registry reconciliation internally, passes the attachment directly to Intake, and returns one compact JSON receipt. Do not stage the attachment separately or call `intake show` after a verified receipt.

```powershell
& $atlasCli intake prepare --root '<AUTHORIZED_ROOT>' --candidate-file '<CANDIDATE_OUTSIDE_ROOT>' --origin '<ORIGIN>' --kind '<KIND>' --project '<PROJECT_ID>' --target '<OPTIONAL_EXACT_NEW_TARGET>' --input '<OPTIONAL_RELATED_INPUT>' --intent '<TASK_INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
# Continue without another pause only when status=prepared, auto_execute=true, confidence>=0.9, and the current user task already authorizes organizing this file.
& $atlasCli intake execute '<RUN_ID>' --reason '<CURRENT_USER_TASK_AUTHORIZATION>' --json
& $atlasCli intake show '<RUN_ID>' --json
& $atlasCli intake batch-plan --root '<AUTHORIZED_ROOT>' --request-file '<ATLAS_STATE_BATCH_JSON>' --json
& $atlasCli intake correct --root '<AUTHORIZED_ROOT>' --scope '<artifact|project|global>' --origin '<ORIGIN>' --kind '<KIND>' --role '<ROLE>' --target-subdirectory '<PROJECT_SUBDIRECTORY>' --reason '<USER_REASON>' --candidate-file '<ARTIFACT_SCOPE_CANDIDATE>' --project '<PROJECT_SCOPE_ID>' --json
```

Origins are `human_submitted`, `human_written`, `agent_generated`, and `download`. Omit `--kind` to use the origin default. Convenience kinds `code` and `demo` map to role `intermediate`; `asset` maps to `source`. Intake creates one new file only. Stop on `needs_input`, `needs_structure_change`, `blocked`, unknown kind, collision, or confidence below `0.9`. Do not turn a missing directory into an implicit create. Use `intake rollback <RUN_ID> --json` only for requested recovery; it uses the same later-change and downstream-lineage protections as Derived.

Use `--target` only when the Agent has already classified one exact new destination from the current user task. It requires `--project`; Atlas validates root and Project containment, existing real parent, and target absence. It avoids forcing a whole-library Contract for one task-scoped placement, but does not create a reusable routing correction.

When `intake execute` returns `verified: true`, `rollback_ready: true`, and the target Hash matches, do not call `intake show` as a routine second receipt. Reserve the full detail command for reconciliation or audit because it includes the complete Candidate Diff.

## Bounded Content Task

Create a request JSON under Atlas runtime state; do not put it in the governed library:

```json
{
  "intent": "Summarize the current chat record",
  "project_id": "<PROJECT_ID>",
  "inputs": [
    { "path": "Sources/chat-jan-may.txt", "series": "chat-main", "temporal_mode": "snapshot", "coverage": { "start": "2026-01-01", "end": "2026-05-31" }, "required": true },
    { "path": "Sources/chat-jan-jul.txt", "series": "chat-main", "temporal_mode": "snapshot", "coverage": { "start": "2026-01-01", "end": "2026-07-31" }, "required": true }
  ],
  "budget": { "max_files": 4, "max_bytes": 1048576 },
  "output": { "target": "Outputs/chat-current.md", "role": "report", "data_class": "temporal_snapshot", "action": "auto" }
}
```

```powershell
& $atlasCli task discover --root '<AUTHORIZED_ROOT>' --project '<PROJECT_ID>' --role '<ROLE>' --extension '<.EXT>' --modified-after '<ISO_TIMESTAMP>' --max-candidates 12 --json
& $atlasCli task prepare --root '<AUTHORIZED_ROOT>' --request-file '<ATLAS_STATE_REQUEST_JSON>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<CONTENT_SKILL>' --client-run-id '<TASK_ID>' --json
# Open only data.read.selected and generate one Candidate outside the governed root.
& $atlasCli task fulfill '<TASK_CONTRACT_RUN_ID>' --candidate-file '<CANDIDATE_OUTSIDE_ROOT>' --reason '<CURRENT_CONTENT_TASK_AUTHORIZATION>' --json
& $atlasCli task show '<TASK_CONTRACT_RUN_ID>' --json
```

`task discover` may run without a Library Contract only when `--project` identifies one active stable Project; in that mode it stays inside the Project and uses structure plus registered Artifact roles, not missing Profile routes. `ready` permits bounded content work. `needs_input` requires only the returned question; `blocked` denies execution. `read.excluded` is a deny-to-read list for this task; budget exclusions distinguish a single oversized file, file-count exhaustion, and total-byte exhaustion. Confirm that `registration.required` and the expected output/lineage records are present before invoking a content Skill. Data classes are `generated_output`, `temporal_snapshot`, `append_only_data`, and `human_writing`. Strategies are `create`, `supersede`, `delta`, `new_version`, `append`, `archive`, or `deny`. An absent-target strategy completes through Derived without a second placement review because the exact Task already authorized it. Append returns `needs_approval`: inspect/approve/execute the returned Guarded run once, then call `task complete '<TASK_ID>' --run '<GUARDED_RUN_ID>' --json`. Archive uses `task archive-plan '<TASK_ID>' --json`, followed by review and execution of its Evolution plan. Recover with `task rollback`; stop on stale inputs, claim conflicts, or later-change conflicts. If the content process cannot be sandboxed, wrap its authorized write area in Tracked Direct so out-of-contract writes become an explicit scope violation.

For binary inputs, use `read.requires_local_extraction` to select a local parser. `read.estimated_tokens` covers only directly readable text bytes; it is not a raw binary-size estimate. Do not send the binary file or a full-resolution render set into model context. Presentation comparison is text/object/layout extraction first, compact local diff second, and at most eight explicitly selected 768×432 JPEG renders only when unresolved visual evidence remains.

## Project Evolution

```powershell
& $atlasCli project evolve '<PROJECT_ID>' --name '<NEW_DISPLAY_NAME>' --alias '<SEARCH_ALIAS>' --reason '<USER_REASON>' --json
& $atlasCli project create --name '<SPLIT_NAME>' --path '<CURRENT_EXISTING_PATH>' --split-from '<SOURCE_PROJECT_ID>' --json
& $atlasCli project merge --source '<OLD_PROJECT_ID>' --into '<TARGET_PROJECT_ID>' --json
& $atlasCli project show '<PROJECT_ID>' --json
```

These commands evolve stable IDs, aliases, status, and lineage. `project evolve` makes no source changes. `project move` is a Registry-only post-migration record update and must not be used as a physical move command.

For one physical change, use the implemented Evolution workflow instead of `project move`:

```powershell
& $atlasCli evolve prepare --root '<AUTHORIZED_ROOT>' --operation '<create_directory|move_file|migrate_project|migrate_directory|remove_empty_directory>' --source '<SOURCE_FOR_MOVE_OR_REMOVAL>' --target '<ABSENT_TARGET>' --project '<PROJECT_ID_FOR_PROJECT_MIGRATION>' --intent '<INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
# Present the exact current plan and pause for approval of this structure change.
& $atlasCli evolve approve '<RUN_ID>' --reason '<USER_REASON>' --json
& $atlasCli evolve execute '<RUN_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
```

For `create_directory`, omit `--source` and `--project`. For `remove_empty_directory`, include `--source` and omit `--target` and `--project`; Atlas refuses any entry inside that directory. For `move_file`, include `--source` and omit `--project`. For `migrate_project`, include `--project`; Atlas derives the source from Registry, and optional `--source` must match it. For `migrate_directory`, include `--source` and inspect the returned classification, control-file evidence, path references, generated caches, package-manager environment, reparse target validity, recommendation, warnings, and blockers before asking for approval. A nested cache should be quarantined through its own reviewed migration before moving the Library; do not merge it into another cache. One run performs one operation. Move/create targets must be absent with an existing real parent. File deletion, non-empty directory deletion, overwrite, cross-filesystem movement, case-only rename, source paths reached through symbolic links, and unsupported special entries remain unsupported. Use `evolve rollback <RUN_ID> --json` only after reconciling with Preview; stop on any manifest, path-claim, later-content, or Registry conflict.

For one user-approved multi-step organization scenario, write an `operations` array to an Atlas-state request file and use:

```powershell
& $atlasCli evolve plan-prepare --root '<AUTHORIZED_ROOT>' --request-file '<ATLAS_STATE_PLAN_JSON>' --intent '<INTENT>' --json
& $atlasCli evolve plan-preview '<PLAN_RUN_ID>' --json
& $atlasCli evolve plan-approve '<PLAN_RUN_ID>' --reason '<ONE_USER_APPROVAL>' --json
# If the evidence or plan is not accepted, close it without source changes:
& $atlasCli evolve plan-reject '<PLAN_RUN_ID>' --reason '<REJECTION_REASON>' --json
& $atlasCli evolve plan-execute '<PLAN_RUN_ID>' --json
& $atlasCli evolve plan-rollback '<PLAN_RUN_ID>' --json
```

Atlas preflights the whole pending plan before the first source write, then stores one child run per item for resumption and reverse rollback. This is not a cross-filesystem transaction and does not add unsupported delete/overwrite operations.

## Derived Classified Create

```powershell
& $atlasCli work stage --file '<GENERATED_CANDIDATE>' --kind candidate --ttl-hours 168 --json
& $atlasCli derive recommend --root '<AUTHORIZED_ROOT>' --input '<RELATIVE_INPUT>' --input '<ANOTHER_INPUT>' --role '<V1_ROLE>' --filename '<FILENAME>' --json
& $atlasCli derive prepare --root '<AUTHORIZED_ROOT>' --input '<RELATIVE_INPUT>' --input '<ANOTHER_INPUT>' --target '<RECOMMENDED_NEW_PROJECT_PATH>' --candidate-file '<WORK_PAYLOAD_PATH>' --project '<PROJECT_ID>' --role '<V1_ROLE>' --relation '<RELATION>' --intent '<INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli derive preview '<RUN_ID>' --json
# Pause and obtain explicit user approval for the recorded placement Prediction and Candidate hash.
& $atlasCli derive approve '<RUN_ID>' --reason '<USER_REASON>' --json
& $atlasCli derive execute '<RUN_ID>' --json
& $atlasCli derive preview '<RUN_ID>' --json
```

Roles are `unclassified`, `raw_input`, `source`, `note`, `journal`, `draft`, `intermediate`, `report`, `canonical`, `index`, `template`, or `archive`. Relations are `derived_from`, `summarizes`, `transforms`, `merges`, `extracts_from`, `supersedes`, `delta_of`, `overlaps`, or `appends_to`; Task Contract normally chooses the temporal/update relations rather than asking the Agent to improvise them. Stop on unresolved, blocked, missing-directory, or route mismatch results until the user reviews them. Use `derive reject` when placement is declined, then `derive revise <RUN_ID> [--target ...] [--role ...] [--candidate-file ...] --reason ... --json` to create a new immutable run. Use `derive promote <RUN_ID> --role canonical --reason ... --json` only after execution and explicit user intent. Use `derive rollback` only when asked to recover; stop on an input-stale, target-claimed, later-output, or downstream-dependency conflict.

## Tracked Direct

```powershell
& $atlasCli begin --root '<AUTHORIZED_ROOT>' --allow '<RELATIVE_PATH>' --intent '<INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
# Agent or authorized external tool edits only allowed paths here.
& $atlasCli close '<RUN_ID>' --json
& $atlasCli show '<RUN_ID>' --json
```

Recovery and interruption:

```powershell
& $atlasCli abort '<RUN_ID>' --reason '<REASON>' --json
& $atlasCli rollback '<RUN_ID>' --json
```

Call rollback only against the run's recorded end state. If exit code is 3 or the envelope reports a state conflict, stop; do not manually restore snapshots over the current file.

## Guarded Existing-File Update

```powershell
& $atlasCli guarded prepare --root '<AUTHORIZED_ROOT>' --target '<RELATIVE_TARGET>' --candidate-file '<ATLAS_STATE_CANDIDATE>' --intent '<INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli guarded preview '<RUN_ID>' --json
# Pause and obtain explicit user approval for this Candidate hash and Diff.
& $atlasCli guarded apply-approved '<RUN_ID>' --reason '<CURRENT_USER_APPROVAL>' --json
```

The fast-path receipt includes verification, rollback readiness, elapsed milliseconds, and the 10-second budget result. Do not call Preview, Execute, or a separate Hash command after a verified receipt. Use `guarded reject` when declined. Use `guarded revise <RUN_ID> --candidate-file <NEW_CANDIDATE> --reason <REASON> --json` for a new immutable candidate, then preview and request approval again.

## Managed Work and Storage

```powershell
& $atlasCli work status --json
& $atlasCli storage status --json
& $atlasCli storage plan --older-than-hours 168 --json
# Present exact candidates and protected classes. Execute only with authorization.
& $atlasCli storage execute --older-than-hours 168 --json
```

Inbox is durable Vault data. Never describe it as Temp. Expired staged Work is reported but not deleted; captured/released Work, stale technical Temp, and unreferenced blobs may enter the plan. Ledger, referenced blobs, backups, staged Work, Inbox, and source Vault files remain protected.

## Reconciliation

```powershell
& $atlasCli status --limit 10 --json
& $atlasCli bootstrap status --json
& $atlasCli show '<RUN_ID>' --json
& $atlasCli guarded preview '<RUN_ID>' --json
& $atlasCli derive preview '<RUN_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
& $atlasCli task show '<TASK_CONTRACT_RUN_ID>' --json
```

Do this after a timeout, cancellation, process crash, or ambiguous tool result. Keep the global run list bounded; use the exact run ID with the workflow detail command when more evidence is needed. Prefer idempotent close, approve, execute, abort, or rollback behavior after checking current status; never start a replacement run merely because output was lost.
