# Atlas CLI Agent Protocol

Locate the user Runtime with `../scripts/locate-atlas.ps1`, set process-local `ATLAS_HOME=install_root` and `ATLAS_STATE_DIR=state_path`, then invoke its returned Node/CLI paths. Add `--json` to every Agent call and apply a 15-second timeout to handshake calls. Omitting `ATLAS_STATE_DIR` can create an unintended second Ledger under Runtime `.atlas/` and is a protocol failure.

The locator has four terminal categories: `ready`, `runtime_required`, `incompatible_protocol`, and `invalid_installation`. Do not fall back to a project-local copy after any non-ready result unless the user explicitly chose that development Runtime.

## Envelope

Success:

```json
{
  "protocol_version": "atlas-cli.v1",
  "atlas_version": "0.1.0",
  "ok": true,
  "command": "begin",
  "data": {}
}
```

Failure:

```json
{
  "protocol_version": "atlas-cli.v1",
  "atlas_version": "0.1.0",
  "ok": false,
  "command": "rollback",
  "error": {
    "code": "ATLAS_ROLLBACK_CONFLICT",
    "message": "...",
    "retryable": false,
    "details": {}
  }
}
```

Require a recognized protocol version and boolean `ok`. Do not treat parse failure, missing fields, stderr prose, or a nonzero exit as success. Preserve the full envelope when reporting an unexpected failure.

## Error Categories

- `ATLAS_PATH_BOUNDARY`: path or state directory escaped an authorized boundary. Correct scope or path; do not retry unchanged.
- `ATLAS_NOT_FOUND`: run, target, Candidate, or material was not found. Reconcile with status/show and verify the exact ID/path.
- `ATLAS_INVALID_ARGUMENT`: command contract was invalid. Check `capabilities` and command syntax.
- `ATLAS_STATE_CONFLICT`: current file/run state or approval precondition no longer matches. Stop writes and report the conflict.
- `ATLAS_ROLLBACK_CONFLICT`: recovery would overwrite a later file state. Stop and preserve the conflict details; never restore manually over it.
- `ATLAS_COMMAND_FAILED`: another deterministic command failure. Inspect the message and current run state before deciding anything.

## Exit Codes

- `0`: command completed; still inspect `data.policy` and verification fields.
- `1`: command or health check failed.
- `2`: `close` completed and recorded a scope or risk violation.
- `3`: rollback conflict; no blind overwrite is allowed.

## Caller Trace Fields

Run-producing commands, including `bootstrap scan`, `bootstrap propose`, and `derive prepare`, accept `--actor`, `--agent`, `--model`, `--tool`, and `--client-run-id`. They are audit metadata, not authentication. Reuse one task ID across related Atlas runs, but always preserve the Atlas-generated run ID as the authoritative operation identity.

`portfolio inventory` is structure-only and returns multiple root candidates without opening file bodies. Depth 1 is the safe disk-level default. Depth 2 fails closed unless one or more exact `--expand` relative directories are supplied; this prevents Atlas from recursively probing installed-software or unknown branches. Root type and PachinStudio relation are separate Predictions. `portfolio review` records the user's type/relation Labels. `portfolio plan` persists a deterministic, read-only map with `source_changes: []`; it is not an Evolution approval and never makes software, Runtime, cache, backup, special, or unknown roots movable.

`inspect --root` is the bounded read-only entry for one known workspace. It skips generated dependencies, caches, toolchains, build outputs, Git internals, and Skill package bodies while reporting those boundaries. A managed Obsidian Library uses `content_policy: root_control_files_only`; ordinary note bodies are not opened. A `.obsidian` marker inside an AGENTS-described website/project is reported as `project_contains_obsidian_config` instead of turning the whole Project into a Vault. Inspect returns top-level role hints, Git marker health, manifests, Skill collections, absolute Windows path references with target existence, reparse points, technical exclusions, verification-command candidates, read counts, access errors, and `source_changes: []`. It creates no Ledger run and makes no source change; the Agent remains responsible for semantic judgment.

Use `capabilities --json` to discover Bootstrap Profiles, the closed V1 Derived role vocabulary, relation types, Work, and storage maintenance. Bootstrap proposal files and Derived Candidate files belong under `.atlas/work`, never inside the governed target. A staged Work item is not disposable merely because its TTL elapsed; prepare/propose must capture it or the user must explicitly release it before cleanup.

`task discover` returns a bounded Project/role/time/extension candidate set without opening file bodies; registered candidates include Artifact, Material, and lineage counts. One stable explicit Project is sufficient for project-scoped structure discovery even when no whole-Library Contract is active; Profile route inference is empty in that mode, while registered Artifact roles remain available. `task prepare` accepts a bounded JSON request file with explicit inputs and/or discovery criteria and returns no input bodies. `read.selected` is the complete permitted read set for that content task; `read.excluded` must not be opened by the calling Skill. Budget exclusions retain `reason: read_budget` and distinguish `single_file_too_large`, `file_count_limit`, or `total_byte_limit` in `budget_reason`. The `contract_id` binds input hashes, read budget, Project path, the active environment RuleVersion or task-scoped environment marker, target, and strategy. `registration` states the required Artifact, Material, lineage, actual Hash, write-run, and rollback records. `task fulfill` auto-completes absent-target Derived creation under the current task authorization, but an append-only existing target returns a Guarded run requiring one exact Candidate approval followed by `task complete`. A changed selected input, Project path, or active Library Contract returns `ATLAS_STATE_CONFLICT`. Concurrent fulfillment has one Ledger claim. Archive produces a reviewed organization plan; delete and arbitrary overwrite are denied.

For different Materials in the same declared series, missing reliable coverage produces `coverage_unknown` with `decision=preserve_both`; it does not silently return zero relations. Both sources remain selected unless the byte budget is too small. Atlas never derives temporal coverage from filenames or modification times.

`intake prepare` may return a plan without a `run_id` when classification, Project, structure, or route is unresolved. This is a successful bounded response, not permission to guess. An Agent may instead provide one explicit absent `--target` with an explicit stable `--project`; Atlas validates the exact task-scoped placement without requiring a whole-library Contract. Only `status: prepared` plus `auto_execute: true` and confidence at least `0.9` allows the Skill to call `intake execute` under the user's current task authorization. `intake show` is a Derived-detail envelope because Intake deliberately reuses the same Candidate, PolicyDecision, lineage, execution, and rollback machinery; it includes the complete Diff and should be reserved for reconciliation or explicit audit after a successful execute receipt.

`guarded apply-approved <run_id> --reason <user_approval>` is the post-review fast path. It records the accepted Label and executes under one state lock, revalidates the approved Candidate and current target, verifies the final Hash, and returns a compact receipt without the Diff. Repeated calls return the existing execution receipt; a stale, rejected, revised, or rolled-back run cannot be replayed. The receipt reports `elapsed_ms` and `within_10_second_budget`.

`intake correct` stores one reviewed route at artifact, Project, or global scope as a new RuleVersion; later matching Intake must reuse it. `intake batch-plan` creates no write runs and coalesces questions across a batch.

`rule context` returns only effective matching preferences for one structured task request, plus conflicts, gaps, default advice, `context_hash`, and attention budget. It does not return historical RuleVersions. `rule propose` accepts an Agent-authored candidate with `kind`, `scope`, `condition`, `value`, `summary`, `basis`, `confidence`, `priority`, and bounded evidence paths inside the governed root. `rule preview` shows current/candidate values and actual consumers. `rule approve` creates one immutable RuleVersion and supersedes only the matching active preference; `rule reject` leaves no active preference. Task and Intake bind the effective context Hash and fail closed when it changes.

`capture localize` accepts a browser-capture JSON envelope produced by the installed Skill helper or a plain selected-text file. It writes the cleaned result to managed Work and the JSON receipt contains no page body. `capture sample` is the only default model-visible content handoff and rejects excerpts above 4,000 characters. A Browser capture must report `capture_scope` and `completeness`; `rendered_message_dom` and `rendered_document_text` do not prove a lazy page is complete.

`evolve prepare` supports only the operations returned by `capabilities`: `create_directory`, `move_file`, `migrate_project`, `migrate_directory`, and `remove_empty_directory`. The last operation requires one real directory with zero entries; it cannot delete files or non-empty trees, and rollback stops if another process reclaimed the path. Every Evolution operation returns `requires_approval: true`. For `migrate_directory`, Preview includes the library/workspace classification, inspected control files, exact old-path references, generated-cache findings, current package-store evidence when available, reparse-point target validity, a recommendation, warnings, and blockers. A nested generated cache or stale internal Junction blocks approval until it has a separate disposition. The Skill must inspect `evolve preview`, present `plan.source_changes`, and pass an explicit reason to `evolve approve` before execution. A stale source/target/Registry state returns `ATLAS_STATE_CONFLICT`; rollback conflicts return `ATLAS_ROLLBACK_CONFLICT`. Neither result authorizes a manual move over the conflicting state.

An organization plan may combine the same implemented operations under one immutable plan and one user approval. `evolve plan-reject` records a declined or superseded prepared plan without source changes. Reject and rebuild a prepared plan when its inspection evidence is known to be incomplete; do not approve an obsolete plan.

A Library Contract ID binds the scan fingerprint, selected Profile, semantic zones, routes, and underlying Profile Prediction IDs. `bootstrap adopt` must receive the exact ID shown to the user and is idempotent; a stale or invented ID is a state conflict. Unrelated unreviewed Predictions become `deferred`, not rejected. An adopted Bootstrap scan and its RuleVersion are immutable. Use `bootstrap scan --new` for a corrected Profile/routing Contract. Storage maintenance is three-phase: `status` and `plan` are read-only; `execute` is the only deletion command and must preserve every protected class returned by the plan.

Ledger restore is Hash-gated: list verified backups with `ledger backups`, then pass the exact returned `current_hash` to `ledger restore`. Atlas validates the source database and writes a safety backup before replacing the current Ledger. Never guess or bypass the Hash.

`analytics export [--name <export_name>] --json` creates a versioned, read-only `atlas.analytics.v1` dataset under the installed state directory. Its Receipt returns `output_dir`, `manifest_path`, `record_count`, and `content_hash`. Consumers must validate `manifest.json` and the listed file Hashes. Python does not read or write `ledger.sqlite`; it receives only the export directory.
