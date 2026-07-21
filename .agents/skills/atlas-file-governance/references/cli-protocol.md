# Atlas CLI Agent Protocol

Use PowerShell and invoke `<ATLAS_ROOT>\atlas.cmd`. Add `--json` to every Agent call.

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

Use `capabilities --json` to discover Bootstrap Profiles, the closed V1 Derived role vocabulary, relation types, Work, and storage maintenance. Bootstrap proposal files and Derived Candidate files belong under `.atlas/work`, never inside the governed target. A staged Work item is not disposable merely because its TTL elapsed; prepare/propose must capture it or the user must explicitly release it before cleanup.

`task prepare` accepts a bounded JSON request file and returns no input bodies. `read.selected` is the complete permitted read set for that content task; `read.excluded` must not be opened by the calling Skill. The `contract_id` binds input hashes, read budget, Project path, active environment RuleVersion, target, and strategy. `task fulfill` auto-completes absent-target Derived creation under the current task authorization, but an append-only existing target returns a Guarded run requiring one exact Candidate approval followed by `task complete`. A changed selected input, Project path, or active Library Contract returns `ATLAS_STATE_CONFLICT`. Delete/archive and arbitrary overwrite are denied.

`intake prepare` may return a plan without a `run_id` when classification, Project, structure, or route is unresolved. This is a successful bounded response, not permission to guess. Only `status: prepared` plus `auto_execute: true` and confidence at least `0.9` allows the Skill to call `intake execute` under the user's current task authorization. `intake show` is a Derived-detail envelope because Intake deliberately reuses the same Candidate, PolicyDecision, lineage, execution, and rollback machinery.

`evolve prepare` supports only `create_directory`, `move_file`, and `migrate_project`. It always returns `requires_approval: true`. The Skill must inspect `evolve preview`, present `plan.source_changes`, and pass an explicit reason to `evolve approve` before execution. A stale source/target/Registry state returns `ATLAS_STATE_CONFLICT`; rollback conflicts return `ATLAS_ROLLBACK_CONFLICT`. Neither result authorizes a manual move over the conflicting state.

A Library Contract ID binds the scan fingerprint, selected Profile, semantic zones, routes, and underlying Profile Prediction IDs. `bootstrap adopt` must receive the exact ID shown to the user and is idempotent; a stale or invented ID is a state conflict. Unrelated unreviewed Predictions become `deferred`, not rejected. An adopted Bootstrap scan and its RuleVersion are immutable. Use `bootstrap scan --new` for a corrected Profile/routing Contract. Storage maintenance is three-phase: `status` and `plan` are read-only; `execute` is the only deletion command and must preserve every protected class returned by the plan.
