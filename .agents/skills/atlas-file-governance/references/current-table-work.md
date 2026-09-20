# Current Table Work

Use this route when the user asks to combine or clean one or more CSV/XLSX Resources inside one active Project. The Host interprets business meaning and proposes field alignment and a Recipe. Atlas owns Source facts, deterministic execution, Preview, Save, verification, relationships, and recovery.

## Start and inspect

Use the installed launcher and `--json` on every call. Include the same caller metadata on related calls.

1. `table-work start --project <project_id> --source <project_file> [--source <project_file> ...] [--intent <text>]` always creates one new Work. `--intent` is optional Work context; it is not a user-visible Work label. Preserve its `session_id` and `revision`.
2. `table-work prepare <session_id> --base-revision <current_revision>`.
3. If an XLSX Source reports `sheet_required`, call `table-work sheet <session_id> --source-key <source_key> --sheet <exact_name> --base-revision <current_revision>`.
4. Read the returned bounded Source profiles and field differences. Do not infer row counts or types from model-visible samples.

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

Every mutating or executing call is bound to the revision returned by the immediately preceding successful call. On `ATLAS_STATE_CONFLICT`, call `table-work show`, compare the current state, and do not retry the old proposal automatically. Stop on missing, changed, failed, or unsupported Sources; stale mapping or Preview; an existing target; or any Project boundary error. Refresh facts and ask for revised intent when needed. Never edit an original Source or replace an Atlas failure with ad hoc Python or PowerShell.

## Discover existing Work

Use `table-work list --project <project_id> [--limit <1..100>] [--offset <nonnegative>] --json` before choosing an existing Work. The default limit is 20. Its pagination is live rather than a snapshot guarantee, so concurrent edits can reorder later pages. Returned Source statuses are stored status values, not fresh file checks. Select one explicit `session_id`, then call `table-work show <session_id>` and use the returned current revision before any update.
