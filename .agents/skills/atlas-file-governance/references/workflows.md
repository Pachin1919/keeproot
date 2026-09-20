# Atlas Current Workflows

This file is supporting reference, not the default route. Prefer `current-resource.md`, `current-table-work.md`, or `current-save.md`.

## Project and Resource lookup

Use `atlas ui` for the installed local surface. Use `project list`, `project show`, `project resolve`, `catalog update`, or `catalog search` only when a Host needs deterministic Project or bounded filename/text facts. These commands do not authorize writing.

## Read Saved Resource Views

First read `capabilities --json`. Use `view list --project <project_id> --json` to discover a Project's Saved Views. A Saved View describes a dynamic scope and display configuration; it is not a frozen Resource selection.

Use `view evaluate <view_id> [--limit <n>] [--continuation <token>] --json` to retrieve a bounded evaluation. Read `complete`, `partial`, or `unknown` together with unchecked scopes, failed scopes, counts, and continuation. `partial` and `unknown` do not mean the returned members are the full scope and do not mean no Resource changed.

Use a continuation only with the evaluation that returned it. If configuration or facts change, Atlas returns `ATLAS_EVALUATION_CHANGED`; discard that continuation and restart the evaluation. Do not merge pages from different evaluations.

For a Project without a Saved View or known Resource identity, use `view files --project <project_id> --scope <relative_or_.> --json`. `--scope` is required; `.` explicitly means the Project root. To retrieve a known Resource record, use `resource show <resource_id> --project <project_id> --json`.

Use `view properties --project <project_id> --json` to read `{ project_id, properties }` and learn the available property definitions before preparing a suggestion. This is read-only. To save a View definition, call `view save --project <project_id> --request-file <json> --tool <tool> --client-run-id <id> --json` with `{ name, mode, config, view_id?, base_revision? }`. Omit `view_id` to create; updating requires a matching `base_revision`. The response returns the stored View and `desktop_href`. This uses the same service as Desktop and changes neither pins, Continue state, nor property values.

View and Resource reads are read-only. When the Host has an evidence-backed semantic suggestion, it may use `view candidates submit` for one explicit Saved View or Resource-ID scope. Submit at most 10 Preview values with the current source version plus `--tool`, `--model`, and `--client-run-id`. Preserve the returned `batch_id`. Atlas stores provenance and shows the suggestions separately; it does not turn them into user properties until the user accepts or edits and accepts them in Desktop. A changed Source becomes `needs_review` and cannot be directly accepted.

After the user works in Desktop, call `view candidates show <batch_id> --project <project_id> --json` to read the original batch metadata and enriched candidates, bounded to the original maximum of 10. Each candidate preserves `stored_status`, `status`, `decision`, `current_value` and `applied_value` (each `{ value, revision, ... }` or `null`), `application_status` (`not_applied`, `current`, `superseded`, `undone`, or `unknown` when acceptance audit data is missing), `source_status` (`current`, `changed`, `missing`, or `unknown` when inspection failed), `basis_source_version`, `current_source_version`, and `can_accept`. `basis_source_version` is the decision's `reviewed_source_version` when present, otherwise historical `source_version`; source comparison uses that basis. `status` exposes a stale stored `pending` candidate as `needs_review`; it does not overwrite decision/history. An accepted candidate that was later undone is not pending or rejected. Do not infer user refusal from an unchanged current value.

The Host flow is: submit, preserve `batch_id`, let the user accept/edit/reject in Desktop, then show and report actual current state. The Skill remains thin and must not approve a candidate itself.

## Inspect or compare

Use `content inspect` for one exact file and `content compare` for two exact files. For XLSX, name one Sheet. Returned structure and counts are local deterministic facts; semantic interpretation stays with the Host.

## Prepare a conversation Save

Use `content localize-conversation --input <selection.json> --project <project_id> --output-relative <existing_folder/new.md> --request-key <key> --tool <tool> --client-run-id <id> --json` with a local Host-selected `atlas.conversation-selection.v1` file. This prepares a Save and returns its `save_id`, `/saves/<save_id>` page, original local selection path/hash/thread ID, and counts. It does not immediately write to a Vault or final Project target.

The returned Save page shows the prepared bounded plain-text preview, whose internal heading is `Selected decisions`, plus recovery state. The user must save through Desktop **Save and verify**, or the Host must use `save execute <save_id> --reason <current_authorization>`. Use `save show`, `save undo`, and `save redo` for the unified Save lifecycle; Resources and Activity show the resulting record.

Treat the selection as locally chosen source evidence, not an original remote chat capture or verified business truth. Atlas records external selection facts only; it does not create Project Material lineage or a custom module registry.

## Save a new result

Use `save prepare`, present the exact target and conflict state, then call `save execute` only under the current user authorization. Success requires `atlas.save-result.v1`, verification, Resource identity, and recovery. Use `save undo` or `save redo`; never replace a Save failure with a different writer.

## Import and Table Work

Desktop and Host Table Work use the same persistent Work identity, revision, and Save path. Desktop selection stays temporary until the user explicitly starts a new Work or names an existing Work to update. Host `table-work start` always creates a new Work and may include `--intent <text>`; Atlas stores that goal with caller metadata for the new Work, while legacy values remain null. Later mutation, Prepare, Preview, and Save calls must use the current `--base-revision`. The Host proposes semantic field alignment and Recipe choices; Atlas validates and performs deterministic local execution. A stale revision stops instead of overwriting newer Desktop state. A Save retry must reuse its request identity and must not create a duplicate target. Source files remain unchanged and output retains all input lineage.

Use `table-work list --project <project_id> [--limit <1..100>] [--offset <nonnegative>] --json` to discover Work summaries in one Project; the default limit is 20. This pagination is live, not a snapshot: concurrent edits can reorder later pages. Source statuses are stored states, not fresh file checks. Select one explicit `session_id`, then call `table-work show <session_id>` before an update to read its current revision.

## Relationships

The Host may propose structured relationships. Atlas validates Resource identity and Project scope, then stores the accepted batch through `resource relationships submit`. Atlas does not infer semantic relationships itself.

## Unsupported requests

Report the missing operation. Do not route to removed Task, Task Review, Analytics, Agent Lifecycle, SessionStart Hook, or hidden Context pages. Internal Guarded, Derived, and Intake modules are implementation details and are not alternate user workflows.
