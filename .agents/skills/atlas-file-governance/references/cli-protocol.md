# Atlas CLI Protocol

Use this reference only for an unfamiliar JSON response or Runtime error.

Run the installed launcher returned by `scripts/locate-atlas.ps1`. Add `--json`, require `protocol_version: atlas-cli.v1`, require boolean `ok`, and preserve the full error envelope when reporting an unexpected failure. Never run Runtime source files directly because that can bypass installed-state binding.

## Current product namespaces

- `ui`: local Desktop surface and its install/doctor/remove lifecycle.
- `save`: prepare, show, execute, undo, and redo one new result.
- `table-work`: share one persistent multi-source CSV/XLSX Work Session with Desktop, from explicit Work creation through Preview and verified Save. Every Host mutation, Prepare, Preview, and Save is bound to the current Work revision.
- `board`: create and revise one Project Board, then prepare a portable Board delivery through the existing Save route.
- `content`: deterministic inspection or comparison of exact authorized files, plus prepare-only localization of a Host-selected local conversation selection.
- `view`: Saved Resource View listing/evaluation, Host view save/update, property-definition reads, bounded Host property-candidate submission, and candidate-batch state reads for user review.
- `resource show`: read one Resource by identity within an explicit Project.
- `resource relationships submit`: persist Host-proposed relationships after Atlas validates identities and Project boundaries.

`capabilities --json` is authoritative. A missing namespace is unsupported; do not reconstruct it through an internal service.

## Experimental protected rounds

Use only when `round_recovery.status` is `experimental` and the user authorized the exact file scope. This is not full Project recovery. The slice accepts explicit ordinary files not registered as Resources (including absent new targets with existing parent directories), explicit active single-location Resources whose active file is also declared in `paths`, explicit open Work Sessions whose Source Resources are all declared, and existing Boards with Text or explicit Material References. Every referenced Resource and its file must be selected; every Board consuming a selected Resource must be explicitly included in the same Project. A Resource restore returns its accepted baseline and appends a `round_restore` audit record without deleting the original action. A Work restore returns its Source configuration, mapping, and Recipe; its revision advances and its Preview is cleared. Do not bypass a refusal with per-file Undo or shell replacement.

All writes use `round <action> --request-file <json> --json`. Keys are camelCase. Include `caller: {actor: "agent", tool: "<host>", client_run_id: "<run>"}` and a new `requestKey` for each protect/extend/checkpoint/restore/return request. Repeating the same key and exact payload does not repeat the write.

- `protect`: `{projectId, paths: ["proposal.md", "new-result.csv"], resourceIds?: ["RES-..."], workIds?: ["DWT-..."], boardIds: [], label, requestKey, caller}`. `resourceIds` is optional with at most 64 active Resources from this Project; each must have one active location and its active file must also appear in exact Project-relative `paths`. `workIds` is optional with at most 20 open Work Sessions from this Project; every Work Source must be a Resource in `resourceIds`. Call BEFORE the first edit; retain `round_id` and `head_node_id`. A failed call grants no protection. Paths are exact Project-relative files, not directory scans.
- `round show <round_id> --project <project_id> --json`: read current facts, including `resource_ids` and `work_ids`. Before each subsequent write, use its `revision` as `baseRevision` and `current_digest` as `expectedDigest`; never reuse the pre-edit digest after editing.
- `checkpoint`: `{projectId, roundId, baseRevision, expectedDigest, label, requestKey, caller}`. Atlas captures the declared state; Host supplies the meaningful stage title.
- `extend`: the checkpoint fields plus additive `paths`, `resourceIds`, `workIds`, `saveIds`, `saveTargets`, or `boardIds`. Call before modifying newly admitted objects. Earlier nodes remain unchanged; recovery to an earlier node uses each added object's admission baseline, not a fabricated earlier state.
- `restore`: `{projectId, roundId, nodeId, baseRevision, expectedDigest, requestKey, caller}`. First retains actual current disk contents in an insurance node, including edits not checkpointed, then restores the selected node. Retain `restore_id` and `return_node_id`.
- `return`: same fields as restore, with `restoreId` instead of `nodeId`. Restores THAT operation's insurance point, not an ambiguous latest node, and also protects the state being left.
- `resume`: `{projectId, roundId, restoreId, caller}`. For a persisted incomplete recovery, rechecks the saved journal and resumes. A conflict must stop; there is no force flag.
- `round list --project <project_id> --json`: lists persisted rounds and incomplete recovery indicators.

Stop other writers and have the user save/close relevant editors before switching state. File hashes, Resource facts, and Work/Board revisions are checked, but Atlas cannot lock external applications. Work and Board revisions advance on restoration; Work Preview is cleared. Resources retain identity, restore the accepted baseline, and append an audit action; they do not have a Work-style revision counter. Old Host assumptions are invalid. `pending_restore` is null only after completion. Pending recovery blocks Work/Resource mutations and related Save entry points. New branches keep prior nodes; history is not automatically deleted. Limits: 64 files, Resources and Saves, 20 Works, 32 MiB per file, 128 MiB total, 10 Boards, 200 nodes per round. Project Home links to the shared round timeline. UI recovery requires a current preview before confirmation; stale previews cannot write.

For an existing executed Save, add `saveIds` to protect/extend and declare its output Resource, output path, all input paths/Source Resources, associated Work and every consumer Board. Result Preview Boards can then recover with the selected files and Work configuration/latest Save pointer. Original Save receipts stay byte-for-byte unchanged; current `save show` verification checks the present file, not just historical success.

For a Save to be created during this round, protect its exact absent output path in both `paths` and `saveTargets` BEFORE preparing the Save. Its parent must already exist. After the Save fully executes, Atlas admits its recorded Resource and Save identities from the existing receipt. Restoring before creation removes the output under insurance, marks that same Resource missing and restores the previous Work pointer/Board blocks. Returning reactivates that identity and content. Do not prepare a second Save for the same slot; prepared/failed/undone Saves and competing claims block recovery.

This experimental route still refuses cross-Project or undeclared dependencies, moved/multi-location Resources, missing pre-existing Resources, closed/missing Work, and Save Undo/Redo status transitions. It does not restore new Work/Board creation, arbitrary directories, editor buffers or Host conversations. A created output missing because of its protected recovery is the explicit Resource-status exception. Never bypass refusal with shell replacement.

## Saved Resource Views and Resource identity

Read `capabilities --json` before using these routes. Listing and evaluation are read-only. Candidate submission never directly writes an accepted user property:

- `view list --project <project_id> --json` lists Saved Views for the Project.
- `view evaluate <view_id> [--limit <n>] [--continuation <token>] --json` evaluates a View's dynamic scope. Read its `completeness` (`complete`, `partial`, or `unknown`), returned/known counts, unchecked scopes, failed scopes, and any continuation before making a claim about the result set.
- `view files --project <project_id> --scope <relative_or_.> --json` lists a bounded scope only when `--scope` is explicit. `.` means the Project root.
- `view properties --project <project_id> --json` returns `{ project_id, properties }`, where `properties` contains this Project's property definitions.
- `view save --project <project_id> --request-file <json> --tool <tool> --client-run-id <id> --json` creates or updates one Saved View through the same service as Desktop and returns the stored View plus `desktop_href`. The request is `{ name, mode, config, view_id?, base_revision? }`: omit `view_id` to create; an update requires its matching `base_revision`.
- `resource show <resource_id> --project <project_id> --json` reads one exact Resource identity in its selected Project. Its `impact_lanes` projection reuses existing Resource, Work, and Save state; it does not create a relationship table. Each lane has `source`, `work`, `results`, `impact`, and navigation actions. `impact.status` is `fresh`, `needs_review`, or `contained`: changed, moved, or missing Sources and `follow_latest` are `needs_review`; pinned Sources are `contained`; a Result that is changed, missing, or undone takes priority as `needs_review`.
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

`table-work reuse <session_id> --base-revision <current_revision> --request-file <assignments.json> --tool <tool> --client-run-id <id> [--intent <text>] --json` creates a distinct Work for the current materials. The request contains one `{source_key,source,sheet}` assignment for every recorded slot; R1 requires the same Source count and one-to-one assignments. Compatible Sheet, fields, and known types rebind only that slot's mapping basis during Prepare. The new Work starts at revision `1` with the recorded mapping meaning and Recipe; Preview and latest Save are not copied. The earlier Work and Result are not modified. Stop on a stale revision or an incomplete/duplicate assignment.

`table-work show` and `prepare` detect changed, moved, and missing Sources but do not adopt a changed version. `show` returns one bounded `change_review` with affected Work/Result identity and, for newly prepared profiles, up to five representative rows; an older profile without samples explicitly reports that its Hash proves identity and is not a backup. Reconcile one Source with `table-work reconcile`, or apply one decision atomically to selected Sources with `table-work reconcile-batch <session_id> --request-file <source-keys.json> --decision <use-current|pin-recorded|follow-latest|stop-using> --base-revision <current_revision> --tool <tool> --client-run-id <id> --json`. The batch request is `{"source_keys":["SRC-...","SRC-..."]}` and increments the Work revision once. Compatible `use-current` rebinds only selected mapping bases; a structural mismatch clears only its own mapping entries and becomes `mapping_required`. `pin-recorded` retains recorded facts, Recipe, mapping, and earlier Results; it does not claim unavailable bytes are backed up. Missing stays on Resource Context relink. Result output integrity remains separate from Source policy and freshness.

## Boards and portable delivery

Use `board list --project <project_id>`, `board create --project <project_id> --title <title>`, and `board show <board_id> --project <project_id>` to read or create one Board. Save an explicit revision only with `board save <board_id> --project <project_id> --base-revision <revision> --request-file <board.json>`.

`board.json` contains a title and only `text`, `material_reference`, or `result_preview` blocks. References use `version_policy` of `follow_latest` or `pinned_version`. Export only with `board export <board_id> --project <project_id> --base-revision <revision> --target <folder/file.html> --request-key <key> --tool <tool> --client-run-id <id>`; it prepares a self-contained HTML Save candidate and does not write the target. Review with `save show <save_id>`, then execute only through `save execute <save_id> --reason <text>`; recovery remains `save undo <save_id>` and `save redo <save_id>`. Missing, unreviewed, over-5 MiB single-file, or over-20 MiB total entries are reported as `Missing or not included`.

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
