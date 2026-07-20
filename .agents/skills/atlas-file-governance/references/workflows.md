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
& $atlasCli bootstrap recommend '<SCAN_ID>' --json
& $atlasCli bootstrap context '<SCAN_ID>' --max-samples 5 --json
# Use Agent reasoning over this bounded context. Inspect only the smallest targeted files if a judgment remains unresolved.
& $atlasCli bootstrap propose '<SCAN_ID>' --proposal-file '<ATLAS_STATE_PROPOSAL_JSON>' --actor agent --agent '<AGENT>' --model '<MODEL>' --tool '<TOOL>' --client-run-id '<TASK_ID>' --json
& $atlasCli bootstrap show '<SCAN_ID>' --json
& $atlasCli bootstrap review '<PREDICTION_ID>' --accept --reason '<USER_REASON>' --json
& $atlasCli bootstrap initialize '<SCAN_ID>' --json
```

Structure mode is the first-pass default for Agent workflows even though the CLI retains `metadata` as its compatibility default. It opens no target file content and does not calculate content hashes. Present the recommended Profile, alternatives, folder mappings, and zero-source-change structure plan; the user may instead request `--profile <PROFILE_ID>`. Use `--scan-mode metadata` only after explicit authorization for hashing all non-ignored files and reading Markdown metadata. Proposal JSON is either an array or `{ "predictions": [...] }`; every item needs `kind`, `summary`, `confidence`, `risk`, `affected_paths`, `evidence`, and `proposed_action`. Use `--reject` or `--correct` instead of `--accept` when that matches the user's review. Do not initialize until every required Prediction has a Label. Do not add an ignore or affected path that escapes the scan root. After Initialize, use `bootstrap scan ... --new` for a corrected review version.

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

Roles are `unclassified`, `raw_input`, `source`, `note`, `journal`, `draft`, `intermediate`, `report`, `canonical`, `index`, `template`, or `archive`. Relations are `derived_from`, `summarizes`, `transforms`, `merges`, or `extracts_from`. Stop on unresolved, blocked, missing-directory, or route mismatch results until the user reviews them. Use `derive reject` when placement is declined, then `derive revise <RUN_ID> [--target ...] [--role ...] [--candidate-file ...] --reason ... --json` to create a new immutable run. Use `derive promote <RUN_ID> --role canonical --reason ... --json` only after execution and explicit user intent. Use `derive rollback` only when asked to recover; stop on an input-stale, target-claimed, later-output, or downstream-dependency conflict.

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
```

Do this after a timeout, cancellation, process crash, or ambiguous tool result. Prefer idempotent close, approve, execute, abort, or rollback behavior after checking current status; never start a replacement run merely because output was lost.
