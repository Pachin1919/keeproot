# Atlas Workflow Commands

Replace placeholders without changing the order. Pass absolute paths where ambiguity is possible. Keep Candidate and state files inside the Atlas project.

Define the CLI path in PowerShell without changing global environment configuration:

```powershell
$atlasCli = '<ATLAS_ROOT>\atlas.cmd'
```

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

Structure mode is the first-pass default for Agent workflows even though the CLI retains `metadata` as its compatibility default. It opens no target file content and does not calculate content hashes. Present one Contract with its recommended Profile, alternatives, zones, routes, at most three questions, and `source_changes: []`; omit `--profile` to use Atlas's deterministic recommendation. Use `--scan-mode metadata` only after explicit authorization for hashing all non-ignored files and reading Markdown metadata. Proposal JSON is either an array or `{ "predictions": [...] }`; every item needs `kind`, `summary`, `confidence`, `risk`, `affected_paths`, `evidence`, and `proposed_action`. If an advanced Agent Prediction must be active in the same RuleVersion, review that specific Prediction before adoption; unreviewed extras are deferred. Do not add an ignore or affected path that escapes the scan root. After adoption, use `bootstrap scan ... --new` for a corrected Contract version.

Compatibility commands `bootstrap recommend`, `bootstrap review`, and `bootstrap initialize` remain available for detailed engineering workflows. The Skill should prefer `contract → adopt` so ordinary users do not review every underlying Prediction.

## Unified Intake

```powershell
& $atlasCli intake prepare --root '<AUTHORIZED_ROOT>' --candidate-file '<CANDIDATE_OUTSIDE_ROOT>' --origin '<ORIGIN>' --kind '<KIND>' --project '<PROJECT_ID>' --input '<OPTIONAL_RELATED_INPUT>' --intent '<TASK_INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
# Continue without another pause only when status=prepared, auto_execute=true, confidence>=0.9, and the current user task already authorizes organizing this file.
& $atlasCli intake execute '<RUN_ID>' --reason '<CURRENT_USER_TASK_AUTHORIZATION>' --json
& $atlasCli intake show '<RUN_ID>' --json
```

Origins are `human_submitted`, `human_written`, `agent_generated`, and `download`. Omit `--kind` to use the origin default. Convenience kinds `code` and `demo` map to role `intermediate`; `asset` maps to `source`. Intake creates one new file only. Stop on `needs_input`, `needs_structure_change`, `blocked`, unknown kind, collision, or confidence below `0.9`. Do not turn a missing directory into an implicit create. Use `intake rollback <RUN_ID> --json` only for requested recovery; it uses the same later-change and downstream-lineage protections as Derived.

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
& $atlasCli task prepare --root '<AUTHORIZED_ROOT>' --request-file '<ATLAS_STATE_REQUEST_JSON>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<CONTENT_SKILL>' --client-run-id '<TASK_ID>' --json
# Open only data.read.selected and generate one Candidate outside the governed root.
& $atlasCli task fulfill '<TASK_CONTRACT_RUN_ID>' --candidate-file '<CANDIDATE_OUTSIDE_ROOT>' --reason '<CURRENT_CONTENT_TASK_AUTHORIZATION>' --json
& $atlasCli task show '<TASK_CONTRACT_RUN_ID>' --json
```

`ready` permits bounded content work. `needs_input` requires only the returned question; `blocked` denies execution. `read.excluded` is a deny-to-read list for this task. Data classes are `generated_output`, `temporal_snapshot`, `append_only_data`, and `human_writing`. Strategies are `create`, `supersede`, `delta`, `new_version`, `append`, or `deny`. An absent-target strategy completes through Derived without a second placement review because the exact Task already authorized it. Append returns `needs_approval`: inspect/approve/execute the returned Guarded run once, then call `task complete '<TASK_ID>' --run '<GUARDED_RUN_ID>' --json`. Recover with `task rollback`; stop on stale inputs or later-change conflicts.

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
& $atlasCli evolve prepare --root '<AUTHORIZED_ROOT>' --operation '<create_directory|move_file|migrate_project>' --source '<SOURCE_FOR_MOVE_FILE>' --target '<ABSENT_TARGET>' --project '<PROJECT_ID_FOR_MIGRATION>' --intent '<INTENT>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
# Present the exact current plan and pause for approval of this structure change.
& $atlasCli evolve approve '<RUN_ID>' --reason '<USER_REASON>' --json
& $atlasCli evolve execute '<RUN_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
```

For `create_directory`, omit `--source` and `--project`. For `move_file`, include `--source` and omit `--project`. For `migrate_project`, include `--project`; Atlas derives the source from Registry, and optional `--source` must match it. One run performs one operation. Targets must be absent with an existing real parent. Delete, overwrite, batch movement, cross-root movement, case-only rename, symbolic links, and special files remain unsupported. Use `evolve rollback <RUN_ID> --json` only after reconciling with Preview; stop on any manifest, path-claim, later-content, or Registry conflict.

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
& $atlasCli guarded approve '<RUN_ID>' --reason '<USER_REASON>' --json
& $atlasCli guarded execute '<RUN_ID>' --json
& $atlasCli guarded preview '<RUN_ID>' --json
```

Use `guarded reject` when declined. Use `guarded revise <RUN_ID> --candidate-file <NEW_CANDIDATE> --reason <REASON> --json` for a new immutable candidate, then preview and request approval again.

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
& $atlasCli status --json
& $atlasCli bootstrap status --json
& $atlasCli show '<RUN_ID>' --json
& $atlasCli guarded preview '<RUN_ID>' --json
& $atlasCli derive preview '<RUN_ID>' --json
& $atlasCli evolve preview '<RUN_ID>' --json
& $atlasCli task show '<TASK_CONTRACT_RUN_ID>' --json
```

Do this after a timeout, cancellation, process crash, or ambiguous tool result. Prefer idempotent close, approve, execute, abort, or rollback behavior after checking current status; never start a replacement run merely because output was lost.
