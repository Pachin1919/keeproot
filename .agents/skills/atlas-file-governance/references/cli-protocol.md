# Atlas CLI Protocol

Use this reference only for an unfamiliar JSON response or Runtime error.

Run the installed launcher returned by `scripts/locate-atlas.ps1`. Add `--json`, require `protocol_version: atlas-cli.v1`, require boolean `ok`, and preserve the full error envelope when reporting an unexpected failure. Never run Runtime source files directly because that can bypass installed-state binding.

## Current product namespaces

- `ui`: local Desktop surface and its install/doctor/remove lifecycle.
- `save`: prepare, show, execute, undo, and redo one new result.
- `table-work`: share one persistent multi-source CSV/XLSX Work Session with Desktop, from explicit Work creation through Preview and verified Save. Every Host mutation, Prepare, Preview, and Save is bound to the current Work revision.
- `content`: deterministic inspection or comparison of exact authorized files, plus prepare-only localization of a Host-selected local conversation selection.
- `view`: Saved Resource View listing/evaluation, Host view save/update, property-definition reads, bounded Host property-candidate submission, and candidate-batch state reads for user review.
- `resource show`: read one Resource by identity within an explicit Project.
- `resource relationships submit`: persist Host-proposed relationships after Atlas validates identities and Project boundaries.

`capabilities --json` is authoritative. A missing namespace is unsupported; do not reconstruct it through an internal service.

## Saved Resource Views and Resource identity

Read `capabilities --json` before using these routes. Listing and evaluation are read-only. Candidate submission never directly writes an accepted user property:

- `view list --project <project_id> --json` lists Saved Views for the Project.
- `view evaluate <view_id> [--limit <n>] [--continuation <token>] --json` evaluates a View's dynamic scope. Read its `completeness` (`complete`, `partial`, or `unknown`), returned/known counts, unchecked scopes, failed scopes, and any continuation before making a claim about the result set.
- `view files --project <project_id> --scope <relative_or_.> --json` lists a bounded scope only when `--scope` is explicit. `.` means the Project root.
- `view properties --project <project_id> --json` returns `{ project_id, properties }`, where `properties` contains this Project's property definitions.
- `view save --project <project_id> --request-file <json> --tool <tool> --client-run-id <id> --json` creates or updates one Saved View through the same service as Desktop and returns the stored View plus `desktop_href`. The request is `{ name, mode, config, view_id?, base_revision? }`: omit `view_id` to create; an update requires its matching `base_revision`.
- `resource show <resource_id> --project <project_id> --json` reads one Resource identity in its Project.
- `view candidates submit --project <project_id> --request-file <json> --tool <tool> --model <model> --client-run-id <id> --json` stores a Preview of 1–10 suggestions. The request must name exactly one scope (`scope.view_id` or `scope.resource_ids`), one existing or proposed property definition, and for every candidate its `resource_id`, current `source_version`, value, and evidence. Desktop keeps these values separate until the user accepts, edits and accepts, or rejects them.
- `view candidates show <batch_id> --project <project_id> --json` returns the original batch metadata and its enriched candidates. It is read-only and returns at most the batch's original 10 candidates.

If a candidate's Source or current property changes, Desktop marks it `needs_review`; direct Accept is unavailable. Do not resubmit merely to bypass review.

For each returned candidate, retain both the historical decision and the current formal property state. `stored_status` is the stored candidate status; `status` is the displayed status, with a stale stored `pending` candidate shown as `needs_review`. `decision` preserves the recorded user decision/history. `current_value` and `applied_value` are `{ value, revision, ... }` or `null`; `applied_value` is the value accepted at the time. `application_status` is `not_applied`, `current`, `superseded`, `undone`, or `unknown` when an accepted record lacks application audit data. `source_status` is `current`, `changed`, `missing`, or `unknown` when inspection failed; `basis_source_version` is `decision.reviewed_source_version` when present, otherwise the original historical `source_version`; and `current_source_version` is the inspected version or `null`. `can_accept` states whether direct user acceptance remains available. An accepted candidate later undone is neither pending nor rejected. An unchanged current value does not establish that the user refused a suggestion.

Host flow: submit and preserve the returned `batch_id`; let the user use Desktop to accept, edit and accept, or reject; then call `view candidates show` to read the actual current state. The Host or Skill never approves a candidate itself.

`view save` changes only the Saved View definition. It does not change Home pins, Continue state, or any property values.

## Table Work discovery

- `table-work list --project <project_id> [--limit <1..100>] [--offset <nonnegative>] --json` lists Work summaries for one Project. The default limit is 20. It returns live pagination, not a snapshot guarantee: concurrent edits can reorder later pages. Source statuses are stored statuses, not fresh file checks.

After selecting an explicit `session_id` from the list, call `table-work show <session_id>` before any update and use its current revision. Do not infer a Work goal or caller metadata from these summaries.

`table-work start` accepts optional `--intent <text>` for a new Work. Atlas stores that goal with caller metadata for the new Work; legacy Work records have null values.

## Conversation Save

`content localize-conversation --input <selection.json> --project <project_id> --output-relative <existing_folder/new.md> --request-key <key> --tool <tool> --client-run-id <id> --json` prepares one conversation Save only. The input is a local Host-selected `atlas.conversation-selection.v1` JSON file. It returns a prepared `save_id`, `desktop_href` (`/saves/<save_id>`), the original local selection path/hash/thread ID, and counts.

The command does not write the final target. The prepared text uses the internal heading `Selected decisions`; inspect it on the returned Save page, which shows a bounded plain-text preview and recovery state. Save only through `save execute <save_id> --reason <current_authorization>` or Desktop **Save and verify**. Use unified `save show`, `save undo`, and `save redo`; Resources and Activity show the resulting record.

The local selection is source evidence chosen by the Host, not an original remote chat capture or verified business truth. Atlas records external selection facts without creating Project Material lineage. This route does not create a custom module registry.

Do not treat `partial` or `unknown` as a full set, or as evidence that no Resource changed. A continuation remains bound to its evaluation facts and configuration. If Atlas returns `ATLAS_EVALUATION_CHANGED`, restart evaluation from the first page instead of continuing with mixed facts.

## Error handling

- `ATLAS_PATH_BOUNDARY`: the path escaped an authorized Root or crossed a link/junction. Correct the path or stop.
- `ATLAS_NOT_FOUND`: verify the exact Resource, Save ID, Project, or path once.
- `ATLAS_INVALID_ARGUMENT`: compare the call with current capabilities and syntax.
- `ATLAS_STATE_CONFLICT`: stop writes and report the changed state. For Table Work, call `table-work show` and do not reuse the stale `base_revision`.
- `ATLAS_ROLLBACK_CONFLICT`: preserve the later file state; never overwrite it manually.
- `ATLAS_COMMAND_FAILED`: inspect the message and current state before deciding anything.
- `ATLAS_EVALUATION_CHANGED`: the View configuration or facts changed while paging. Discard the continuation and start a new evaluation.

Exit `0` means the command returned successfully; still check its status and verification fields. Exit `1` is a failed command or health check. Exit `2` records a tracked scope/risk violation. Exit `3` is a recovery conflict.

Caller fields (`--actor`, `--agent`, `--model`, `--tool`, `--client-run-id`) are audit metadata, not authentication. Reuse the caller run ID for related calls and preserve Atlas-generated operation IDs.

Historical SQLite tables may exist after upgrades. They have no product or Skill command route and must not be interpreted as pending user work.
