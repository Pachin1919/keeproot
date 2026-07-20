---
name: atlas-file-governance
description: Use the project-local Atlas 0.1 CLI preview to scan an authorized file library, create one classified output with input lineage, track ordinary edits, protect one existing-file update, inspect receipts, or recover a governed change. Trigger for Atlas Bootstrap, Derived, Tracked Direct, Guarded, Ledger, or rollback requests. If the local Atlas runtime is unavailable, recommend installation instead of improvising file governance or writing runtime data into the target library.
---

# Atlas File Governance

This is a project-local Atlas 0.1 preview, not the installable Atlas V1 product. Use only implemented capabilities returned by `capabilities --json`.

Use Atlas as the deterministic governance harness around Agent file work. Let the Agent understand and author content; let Atlas establish boundaries, capture baselines, route risk, persist evidence, and protect recovery.

## Locate and Check Atlas

1. Find the Atlas project root without scanning unrelated directories. Prefer the current repository when it contains `atlas.cmd` and `package.json`; otherwise use the user-provided Atlas path. Do not guess a different installation.
2. If no verified root is available, stop with `runtime_required`. Recommend installing the local Atlas runtime and this Skill at user scope; do not copy CLI code, dependencies, SQLite state, or caches into the target Vault/project. Atlas 0.1 does not yet provide an automatic installer.
3. Run `<ATLAS_ROOT>\atlas.cmd version --json`, `capabilities --json`, and `doctor --json`.
4. Parse stdout as JSON. Require `protocol_version == "atlas-cli.v1"` and `ok == true`. Stop on a failed Doctor check.
5. Keep `ATLAS_STATE_DIR` inside the Atlas project. Never place Ledger, snapshots, candidates, logs, or test output in the governed Vault. Treat Vault Inbox as durable data, not Temp.

Read [references/cli-protocol.md](references/cli-protocol.md) before constructing commands or handling a failure. Read [references/workflows.md](references/workflows.md) for the selected workflow.

## Select One Workflow

- Use **Bootstrap** for “read/recognize this existing library,” “map this Vault,” “find structural issues,” or “suggest improvements.” It is structure-first and read-only toward the target by default.
- Use **Derived** when Agent-generated content must become a new governed file with an explicit Project, role, destination, and input lineage.
- Use **Tracked Direct** for an authorized, low-risk, ordinary edit with narrow known paths.
- Use **Guarded** for formal or important files, rules or `AGENTS.md`, delete/move/rename, structural changes, broad batches, difficult recovery, or any route returned as `guarded`.
- Stop when Atlas returns `deny`. Never bypass the Risk Engine by changing the requested mode or splitting the operation merely to lower its score.
- When uncertain, evaluate with `atlas risk ... --json` and obey the returned mode. Prefer Guarded when material risk remains unresolved.

## Common Run Rules

For every run-producing command, include:

```text
--actor agent --agent <agent-name> --model <model-name> --tool <calling-tool> --client-run-id <task-id>
```

Use the narrowest authorized root and scopes. Save every returned `run_id` or `scan_id`; never recover IDs by scraping human output. Before retrying after interruption, use `status --json` and `show <run_id> --json` or `guarded preview <run_id> --json` to reconcile state.

Check both the process exit code and the JSON body. A completed `close` may return `ok: true` while `data.policy` is `violation`; treat that as a governance failure and report the changed paths. Do not continue silently.

## Bootstrap

Scan only a root the user explicitly placed in scope. Start with `--scan-mode structure`: it reads paths, file types, sizes, and modification times without opening file content or calculating content hashes. Use `--ignore` for known caches or generated directories. Do not present structure-only Predictions as confirmed defects.

Use `--scan-mode metadata` only after the user authorizes content hashing and Markdown metadata reads. It hashes every non-ignored file and reads up to 2 MiB from each Markdown file for titles, property names, tags, and links; it still must not send the whole corpus to model context.

After Scan, request `bootstrap context`; it is a bounded structural summary with no file bodies. Use Agent reasoning to propose project boundaries, folder or artifact roles, candidate naming/routing rules, and structural improvements. Inspect body content only for a specific unresolved judgment and only from the smallest relevant file set. Write proposals as JSON under Atlas runtime state, then submit them with `bootstrap propose`; never invent affected paths that were not observed by that scan.

Before inventing a structure, inspect `bootstrap profiles` and request `bootstrap recommend`. The four bundled Profiles are review candidates for mixed-minimal, personal knowledge, project work, and research/writing libraries. Present the evidence, alternatives, individual folder mappings, and read-only structure plan. A Profile must never authorize directory creation or source migration.

Show every Prediction with its evidence, confidence, affected paths, risk, proposed action, and Agent caller trace. Keep Predictions distinct from Observations, Labels, and PolicyDecisions. Ask the user before accepting, rejecting, or correcting recommendations. Initialize only after required reviews; Initialize writes maps, classifications, structure plans, and an accepted environment RuleVersion under Atlas state and must not move, rename, or rewrite source files. Never relabel an initialized scan; use `bootstrap scan --new` for another version. Applying a structure recommendation to the target requires a later governed workflow.

## Derived

Stage generated candidates with `work stage`, then use its `payload_path`; never write the Candidate into the governed root before execution. Use `derive recommend` to apply the active Profile, reviewed custom routing, input Project, role, and filename. Stop for unresolved/blocked results and surface missing-directory warnings instead of creating a directory.

Use `derive prepare` for a new generated file. Declare every existing input, one active Project, a supported closed V1 role, the new target path, and a lineage relation. The target must be absent, have a real existing parent, and remain inside the selected Project. Prepare captures managed Work and marks it `captured`.

Preview the Candidate Diff, placement Prediction, route policy, input hashes, role, and destination. Obtain explicit user approval for that placement before `derive execute`. Execution must stop if an input changed or another process claimed the target. If rejected, use `derive revise` for a new immutable Candidate and request approval again. After execution, verify the output Artifact/Material and lineage receipt. Use `derive promote` only for an allowed role transition such as draft to canonical; it must not change Material or path. The output may be an input to a later Derived run. Rollback removes only the exact recorded output version and must stop on later edits or active downstream runs; lineage remains in the Ledger as history.

Use `storage status`, then `storage plan`, before any `storage execute`. Never delete staged Work, referenced blobs, Ledger, backups, Inbox, or source files. An expired staged item is a warning, not cleanup authorization.

## Tracked Direct

1. Run `begin --json` before any edit, with exact `--allow` files or the smallest safe directory.
2. Confirm the returned mode is `tracked_direct` and status is `open`.
3. Make only the authorized changes.
4. Run `close <run_id> --json` even when the edit failed or produced no change, so the actual window is recorded.
5. Require no scope violations and `data.policy == "pass"`. Inspect `show <run_id> --json` for the actual Diff and events.
6. Roll back only when requested or when an authorized recovery is necessary. Atlas must stop on a later-change conflict; never overwrite it manually.

If the task is cancelled before any change, use `abort`. If Atlas reports that files changed, use `close` instead of hiding the run.

## Guarded

Create the candidate outside the governed target, under Atlas runtime state. Run `prepare`, then inspect `preview` and present the meaningful Diff, risk, and recovery route to the user. Do not call `approve` without explicit approval for the current candidate.

After approval, execute exactly that candidate and verify the returned receipt plus the current file result. A changed target invalidates approval; preview or revise again. Rejecting or revising must preserve the previous Candidate ChangeSet. Rollback must stop rather than overwrite later legitimate changes.

V1 Guarded execution supports only updating one existing regular file. Do not imply support for Guarded create, delete, move, rename, or batch execution.

## Report the Outcome

Return a short human summary containing the selected mode, run ID, actual changed paths, policy result, verification result, and recovery availability. Surface conflicts, violations, unresolved Predictions, and unsupported operations plainly. Do not call Fixture-only success production validation, and do not scan a real Vault without explicit authorization.
