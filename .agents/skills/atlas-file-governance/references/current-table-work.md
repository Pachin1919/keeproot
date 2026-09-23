# Current Table Work

Use this route when the user asks to combine or clean one or more CSV/XLSX Resources inside one active Project. The Host interprets business meaning and proposes field alignment and a Recipe. Atlas owns Source facts, deterministic execution, Preview, Save, verification, relationships, and recovery.

## Start and inspect

Use the installed launcher and `--json` on every call. Include the same caller metadata on related calls.

1. `table-work start --project <project_id> --source <project_file> [--source <project_file> ...] [--intent <text>]` always creates one new Work. `--intent` is optional Work context; it is not a user-visible Work label. Preserve its `session_id` and `revision`.
2. `table-work prepare <session_id> --base-revision <current_revision>`.
3. If an XLSX Source reports `sheet_required`, call `table-work sheet <session_id> --source-key <source_key> --sheet <exact_name> --base-revision <current_revision>`.
4. Read the returned bounded Source profiles and field differences. Do not infer row counts or types from model-visible samples.

## Check and reconcile Sources

`table-work show` and `prepare` check Sources for changed, moved, or missing state. They do not adopt a changed Source automatically. `show` returns one bounded `change_review` containing the affected Work/latest Result and representative values when the recorded profile supports them. A recorded Hash proves identity; it is not a backup.

After `show` returns the current revision, reconcile one explicit Source with `table-work reconcile <session_id> --source-key <source_key> ...`, or apply the same decision to selected Sources with `table-work reconcile-batch <session_id> --request-file <source-keys.json> --decision <use-current|pin-recorded|follow-latest|stop-using> --base-revision <current_revision> --tool <tool> --client-run-id <id> --json`. The request is `{"source_keys":["SRC-...","SRC-..."]}` and the batch changes the Work revision once.

Compatible `use-current` adopts current fingerprints/profiles and rebinds only the affected mapping basis, so the existing Recipe can Preview without reviewing unrelated fields. A structural mismatch becomes `mapping_required` only for that Source. `pin-recorded` keeps recorded facts, mapping, Recipe, and earlier Results, but does not claim a new execution is possible when recorded bytes are unavailable. `follow-latest` releases a pin. `stop-using` removes selected Sources while retaining at least one. For Missing, use Resource Context relink first. Result output integrity is separate from Source policy and freshness.

To inspect a saved Result's current impact without creating new relationships, call `resource show <resource_id> --project <project_id> --json` for its exact Resource ID and selected Project. Read its bounded `impact_lanes`: each projection follows Source → Work → Result and reports `fresh`, `needs_review`, or `contained`. Changed, moved, missing, and `follow_latest` Sources need review; pinned Sources are contained. A changed, missing, or undone Result remains `needs_review` even when its Source is pinned.

## Propose alignment and Recipe

Write a technical request JSON outside the governed Project source files.

Alignment request:

```json
{"mapping":[{"source_key":"SRC-...","column":"Customer","canonical":"customer_id"}]}
```

Every prepared `(source_key, column)` must appear exactly once. Call `table-work align <session_id> --request-file <mapping.json> --base-revision <current_revision>`.

Recipe request uses the supported fields returned by Atlas: `combine` (`concatenate` or `join`), `join_how`, `left_key`, `right_key`, `source_column`, `source_column_name`, `cast_column`, `cast_type`, `filter_column`, `filter_operator`, `filter_value`, `fill_column`, `fill_value`, `select_columns`, `deduplicate_columns`, `sort_column`, `sort_direction`, `rename_column`, and `rename_to`. Call `table-work recipe <session_id> --request-file <recipe.json> --base-revision <current_revision>` and preserve the returned revision.

Semantic equivalence is a Host proposal, not an Atlas fact. Do not silently align differently named business fields without user intent or adequate evidence.

## Preview and save

1. Call `table-work preview <session_id> --base-revision <current_revision>` and report the bounded sample plus full-result counts and validation facts.
2. Save only after the current Preview is accepted: `table-work save <session_id> --folder <existing_project_folder> --file-name <new.csv|new.xlsx> --format <csv|xlsx> --base-revision <current_revision> --request-key <stable_key> --reason <current_authorization> --tool <name> --client-run-id <id>`.
3. Require an executed Save with a verification hash and all Source relationships.
4. Use `save undo <save_id>` or `save redo <save_id>` for recovery.

Every mutating or executing call is bound to the revision returned by the immediately preceding successful call. On `ATLAS_STATE_CONFLICT`, call `table-work show`, compare the current state, and do not retry the old proposal automatically. Stop on missing, changed, failed, or unsupported Sources until the required reconciliation decision is recorded; also stop on stale mapping or Preview, an existing target, or any Project boundary error. Refresh facts and ask for revised intent when needed. Never edit an original Source or replace an Atlas failure with ad hoc Python or PowerShell.

## Discover existing Work

Use `table-work list --project <project_id> [--limit <1..100>] [--offset <nonnegative>] --json` before choosing an existing Work. The default limit is 20. Its pagination is live rather than a snapshot guarantee, so concurrent edits can reorder later pages. Returned Source statuses are stored status values, not fresh file checks. Select one explicit `session_id`, then call `table-work show <session_id>` and use the returned current revision before any update.

To apply the same setup to the current materials without changing the earlier Work or Result, first use `list` and `show`, then call `table-work reuse <session_id> --base-revision <current_revision> --request-file <assignments.json> --tool <tool> --client-run-id <id> [--intent <text>] --json`. Assign every recorded `source_key` to exactly one current Project file. R1 requires the same count and one-to-one assignments. The new Work starts at revision `1`, keeps the recorded mapping meaning and Recipe, and copies neither Preview nor latest Save. Compatible Prepare rebinds each slot; incompatible slots stop independently.

## Board delivery

A Project Board can contain only Material Reference, Text, and Result Preview blocks. Reference policy is `follow_latest` or `pinned_version`. Use `board show <board_id> --project <project_id>` before `board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>`; stale revisions stop.

`board export <board_id> --project <project_id> --base-revision <revision> --target <folder/file.html> --request-key <key> --tool <tool> --client-run-id <id>` prepares a self-contained HTML candidate through the existing Save route. Review it with `save show <save_id>`, then use `save execute <save_id> --reason <text>`, `save undo <save_id>`, or `save redo <save_id>`. It does not create a second delivery or recovery system. Missing or unreviewed entries, a file above 5 MiB, or a total above 20 MiB are `Missing or not included`.
