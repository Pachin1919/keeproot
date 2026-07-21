---
name: atlas-file-governance
description: Use the project-local Atlas 0.1 CLI preview to recognize an authorized library, adopt routing rules, classify incoming files, issue a bounded content Task Contract, evolve one reviewed path, track edits, protect one existing-file update, inspect lineage, or recover a governed change. Trigger for Atlas Bootstrap, Intake, Task Contract, Project, Evolution, Derived, Tracked Direct, Guarded, Ledger, or rollback requests. If the local Atlas runtime is unavailable, recommend installation instead of improvising file governance or writing runtime data into the target library.
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
- Use **Intake** when a user submission, human-written file, Agent output, or download must be classified and placed as a new Project file. It is the preferred simple entry for new files.
- Use **Task Contract** before a content Skill reads several candidate sources or generates/updates a governed output. It chooses a bounded read set, explains duplicate or temporal overlap, and binds one exact output strategy and target.
- Use **Evolution** for exactly one reviewed directory create, existing-file move, or whole-Project directory migration. It always requires approval of the current plan and is not a generic batch/delete tool.
- Use **Derived** when generated content needs explicit multi-input lineage, a custom relation, placement revision, or role promotion.
- Use **Tracked Direct** for an authorized, low-risk, ordinary edit with narrow known paths.
- Use **Guarded** for an implemented formal or important existing-file content update, including rules or `AGENTS.md`. A `guarded` risk result does not invent unsupported delete or batch capability; use Evolution only for its three exact operations and report other structural actions as unsupported.
- Stop when Atlas returns `deny`. Never bypass the Risk Engine by changing the requested mode or splitting the operation merely to lower its score.
- When uncertain, evaluate with `atlas risk ... --json` and obey the returned mode. Prefer Guarded when material risk remains unresolved.

## Common Run Rules

For every run-producing command, including `evolve prepare`, include:

```text
--actor agent --agent <agent-name> --model <model-name> --tool <calling-tool> --client-run-id <task-id>
```

Use the narrowest authorized root and scopes. Save every returned `run_id` or `scan_id`; never recover IDs by scraping human output. Before retrying after interruption, use the workflow detail command such as `show`, `guarded preview`, `derive preview`, or `evolve preview` to reconcile state.

Check both the process exit code and the JSON body. A completed `close` may return `ok: true` while `data.policy` is `violation`; treat that as a governance failure and report the changed paths. Do not continue silently.

## Bootstrap

Scan only a root the user explicitly placed in scope. Start with `--scan-mode structure`: it reads paths, file types, sizes, and modification times without opening file content or calculating content hashes. Use `--ignore` for known caches or generated directories. Do not present structure-only Predictions as confirmed defects.

Use `--scan-mode metadata` only after the user authorizes content hashing and Markdown metadata reads. It hashes every non-ignored file and reads up to 2 MiB from each Markdown file for titles, property names, tags, and links; it still must not send the whole corpus to model context.

After Scan, request `bootstrap context`; it is a bounded structural summary with no file bodies. Use Agent reasoning only when the deterministic Contract leaves a material uncertainty. It may propose project boundaries, folder or artifact roles, candidate naming/routing rules, and structural improvements. Inspect body content only for a specific unresolved judgment and only from the smallest relevant file set. Write proposals as JSON under Atlas runtime state, then submit them with `bootstrap propose`; never invent affected paths that were not observed by that scan.

Before inventing a structure, inspect `bootstrap profiles` and request `bootstrap contract`. The four bundled Profiles cover mixed-minimal, personal knowledge, project work, and research/writing libraries. Present one compact Contract containing the selected Profile, evidence, alternatives, semantic zones, deterministic routes, missing-area suggestions, and at most three unresolved mapping questions. A Contract must have `source_changes: []`; it never authorizes directory creation or source migration.

Ask once before `bootstrap adopt`, using the exact `contract_id` the user saw. Adoption accepts the Profile evidence as one user decision and records unrelated unreviewed Predictions as `deferred`, not falsely rejected. If the Contract says `needs_input`, ask only its listed questions and do not adopt yet. Advanced Agent Predictions may still be reviewed individually when the user explicitly wants them included. Keep Predictions distinct from Observations, Labels, and PolicyDecisions. Adoption writes maps, classifications, the Contract, and an accepted environment RuleVersion under Atlas state; it must not move, rename, create, or rewrite source files. Never relabel an initialized scan; use `bootstrap scan --new` for another version. Applying a structure suggestion to the target requires a later governed workflow.

## Derived

Stage generated candidates with `work stage`, then use its `payload_path`; never write the Candidate into the governed root before execution. Use `derive recommend` to apply the active Profile, reviewed custom routing, input Project, role, and filename. Stop for unresolved/blocked results and surface missing-directory warnings instead of creating a directory.

Use `derive prepare` for a new generated file. Declare every existing input, one active Project, a supported closed V1 role, the new target path, and a lineage relation. The target must be absent, have a real existing parent, and remain inside the selected Project. Prepare captures managed Work and marks it `captured`.

Preview the Candidate Diff, placement Prediction, route policy, input hashes, role, and destination. Obtain explicit user approval for that placement before `derive execute`. Execution must stop if an input changed or another process claimed the target. If rejected, use `derive revise` for a new immutable Candidate and request approval again. After execution, verify the output Artifact/Material and lineage receipt. Use `derive promote` only for an allowed role transition such as draft to canonical; it must not change Material or path. The output may be an input to a later Derived run. Rollback removes only the exact recorded output version and must stop on later edits or active downstream runs; lineage remains in the Ledger as history.

Use `storage status`, then `storage plan`, before any `storage execute`. Never delete staged Work, referenced blobs, Ledger, backups, Inbox, or source files. An expired staged item is a warning, not cleanup authorization.

## Task Contract

Use Task Contract as the preferred handoff to writing, summarization, analysis, PPT, website-content, or other content-production Skills. Create a small JSON request under Atlas runtime state containing the intent, stable Project ID, explicit candidate inputs with optional series/date coverage, a read budget, and one output target/role/data class. Run `task prepare` before opening input bodies.

Read only `data.read.selected`; never open `read.excluded` merely because the Agent believes it may help. Atlas may exclude byte-identical copies or an older snapshot only when the newer file's declared coverage contains it and its bytes were deterministically verified. Partial or unverified overlap keeps both. If status is `needs_input`, ask only the returned bounded question; if `blocked`, do not generate or write.

Generate the Candidate outside the governed root. For an absent target, `task fulfill` reuses the user's current content-task authorization to run Derived and returns completed lineage without a redundant placement question. For an existing append-only target it stages a Guarded Candidate and returns `needs_approval`; show that exact Diff once, then use Guarded approve/execute and `task complete`. Delete, archive, arbitrary overwrite, batch write, or reading beyond the Contract remain unsupported. Use `task show` to reconcile, and `task rollback` only when recovery is requested. Any selected-input, Project-path, or active Library Contract change makes the Task stale.

## Intake

Use `intake prepare` with exactly one origin: `human_submitted`, `human_written`, `agent_generated`, or `download`. Supply a known kind when available; otherwise let the origin default to `raw_input`, `note`, `intermediate`, or `source`. The V1 convenience kinds `code` and `demo` remain `intermediate`; `asset` remains `source`. Atlas preserves both the user-facing kind and Foundation role in the placement Prediction.

For a ready plan with `auto_execute: true` and confidence at least `0.9`, execute without asking a second file-placement question when the user's current task already authorizes organizing that file. Pass that task authorization as `--reason`. This still records a Label, PolicyDecision, Artifact, Material, origin/kind context, and rollback route. If Atlas returns `needs_input`, `blocked`, a route conflict, or an unknown kind, stop and ask only the returned bounded question. For `needs_structure_change`, present the exact missing area and use a separate Evolution directory plan only after the user approves that structure change; then prepare Intake again. Never choose among multiple Projects silently.

The Candidate must stay outside the governed root until execution. Intake creates one new file and never overwrites, moves, or deletes. It may have zero related inputs for an original submission/download, or explicit `--input` paths when lineage exists. Verify with `intake show`; rollback must preserve the external Candidate and refuse later target changes.

## Project Evolution

Treat a Project ID as the stable identity and its name/path as changeable views. Use `project evolve` when a category meaning expands, narrows, pauses, or is archived. A rename automatically retains the prior name as an alias and returns `source_changes: []`; this is how “就业” can become “就业与生活” without a forced folder move. Use `project create --split-from` and `project merge` to preserve split/merge lineage rather than deleting old identities.

`project move` updates Registry history only; it does not move a directory. Never call it before a separately governed physical migration has completed and been verified.

Use top-level `evolve` for one physical operation:

- `create_directory`: create one absent directory whose real parent already exists.
- `move_file`: rename one existing regular file to one absent target under the same authorized root.
- `migrate_project`: move the current registered Project directory to one absent target, verify its complete manifest, then update Registry.

Always run `evolve prepare`, inspect `evolve preview`, and show the exact source changes, manifest summary, risk, and recovery route. Obtain explicit approval for that plan before `evolve approve` and `evolve execute`. Preparation or approval is invalid if the source manifest, target absence, Project Registry path, or plan changes. Recovery must stop if later files appeared, content changed, the original path was reclaimed, or Registry evolved again. Do not use Evolution for delete, overwrite, merge/split batch migration, cross-root movement, case-only rename, symbolic links, or special files.

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

V1 Guarded execution supports only updating one existing regular file. Evolution separately supports its three exact filesystem operations. Do not imply support for Guarded create, delete, move, rename, or batch execution.

## Report the Outcome

Return a short human summary containing the selected mode, run ID, actual changed paths, policy result, verification result, and recovery availability. Surface conflicts, violations, unresolved Predictions, and unsupported operations plainly. Do not call Fixture-only success production validation, and do not scan a real Vault without explicit authorization.
