---
name: atlas-file-governance
description: Use the user-installed Atlas local Runtime to inspect an authorized workspace, recognize a library, classify and place files, govern Agent outputs, issue a bounded content Task Contract, evolve reviewed paths, track edits, or recover changes. Trigger for project/workspace inspection, Atlas Bootstrap, Intake, Task Contract, Project, Evolution, Derived, Tracked Direct, Guarded, Ledger, rollback, Vault organization, PPT material routing, Website source/demo isolation, attached files, or durable Agent outputs. If the Runtime is unavailable or incompatible, return runtime_required and recommend the Atlas installer instead of improvising governance.
---

# Atlas File Governance

Use only capabilities returned by the installed Runtime's `capabilities --json`. The repository copy of this Skill is its distributable source, not a requirement for target projects.

Use Atlas as the deterministic governance harness around Agent file work. Let the Agent understand and author content; let Atlas establish boundaries, capture baselines, route risk, persist evidence, and protect recovery.

## Locate and Check Atlas

1. Run `scripts/locate-atlas.ps1`. It checks `ATLAS_HOME` first and otherwise the user installation at `%LOCALAPPDATA%\Atlas`; do not scan unrelated drives or target projects.
2. If it returns `runtime_required`, stop before reading or writing the target. Recommend running `install-atlas.ps1 install`; do not copy CLI code, Node, SQLite state, or caches into the Vault/project.
3. Before using the returned Node path, `node_args`, and CLI path, set process-local `ATLAS_HOME` to `install_root` and `ATLAS_STATE_DIR` to `state_path`. Then run `version --json`, `capabilities --json`, and `doctor --json`, each with a 15-second timeout. Never omit the state variable: otherwise the CLI can create a second Ledger under Runtime `.atlas/`.
4. Parse stdout as one JSON object. Require exit code 0, empty stderr, `protocol_version == "atlas-cli.v1"`, boolean `ok == true`, the expected command, and Doctor `status == "ok"`. Old protocol, timeout, prose, or malformed JSON fails closed.
5. Keep Runtime state under the user Atlas installation. Never place Ledger, snapshots, candidates, logs, or test output in the governed Vault. Treat Vault Inbox as durable data, not Temp.

Read [references/cli-protocol.md](references/cli-protocol.md) before constructing commands or handling a failure. Read [references/workflows.md](references/workflows.md) for the selected workflow.

## Select One Workflow

- Use **Workspace Inspect** for one known Project, Library, or mixed tool root. It returns bounded filesystem/control facts for Agent judgment and makes no source change.
- Use **Portfolio** before Bootstrap when one disk or workspace contains several independent roots, including libraries, repositories, projects, installed/portable software, runtimes, package stores, caches, and backups. It is structure-only and read-only; unknown roots never become migration candidates.
- Use **Bootstrap** for “read/recognize this existing library,” “map this Vault,” “find structural issues,” or “suggest improvements.” It is structure-first and read-only toward the target by default.
- Use **Intake** when a user submission, human-written file, Agent output, or download must be classified and placed as a new Project file. It is the preferred simple entry for new files.
- Use **Browser Capture** before Intake when an identified web page or selected browser text must become a local file. The browser bridge saves content directly to Atlas Temp; Atlas localizes it into managed Work and returns no body text by default.
- Use **Task Contract** before a content Skill reads several candidate sources or generates/updates a governed output. It chooses a bounded read set, explains duplicate or temporal overlap, and binds one exact output strategy and target.
- Use **Evolution** for a reviewed directory create, verified empty-directory removal, existing-file move, whole-Project directory migration, or one immutable multi-step organization plan composed from supported operations. A multi-step plan is approved once, then preflighted and executed item by item; it is not a generic delete tool or filesystem transaction.
- Use **Derived** when generated content needs explicit multi-input lineage, a custom relation, placement revision, or role promotion.
- Use **Tracked Direct** for an authorized, low-risk, ordinary edit with narrow known paths.
- Use **Guarded** for an implemented formal or important existing-file content update, including rules or `AGENTS.md`. A `guarded` risk result does not invent unsupported delete or batch capability; use Evolution only for its advertised exact operations and report other structural actions as unsupported.
- Stop when Atlas returns `deny`. Never bypass the Risk Engine by changing the requested mode or splitting the operation merely to lower its score.
- When uncertain, evaluate with `atlas risk ... --json` and obey the returned mode. Prefer Guarded when material risk remains unresolved.

## Common Run Rules

For every run-producing command, including `evolve prepare`, include:

```text
--actor agent --agent <agent-name> --model <model-name> --tool <calling-tool> --client-run-id <task-id>
```

Use the narrowest authorized root and scopes. Save every returned `run_id` or `scan_id`; never recover IDs by scraping human output. Before retrying after interruption, use the workflow detail command such as `show`, `guarded preview`, `derive preview`, or `evolve preview` to reconcile state.

Check both the process exit code and the JSON body. A completed `close` may return `ok: true` while `data.policy` is `violation`; treat that as a governance failure and report the changed paths. Do not continue silently.

## Workspace Inspect

Run `atlas inspect --root <AUTHORIZED_ROOT> --max-depth 6 --json` before asking the user to classify a known mixed root or before proposing project-internal cleanup. It is read-only and creates no governance run.

Use its top-level role hints, Git marker health, manifests, local Skill collections, absolute-path references, reparse points, technical exclusions, and verification-command candidates as facts. They are not semantic conclusions. Read only the listed control files needed for the decision; let the Agent interpret project purpose and rules. Treat missing path targets and invalid Git markers as items to review, not automatic delete authority.

For a managed Obsidian Library, require `content_policy: root_control_files_only`; do not open ordinary note bodies. A `.obsidian` directory alone is not enough to classify a Project as a Vault: reconcile it with the root AGENTS/README and report `project_contains_obsidian_config` when project evidence wins.

When Inspect starts inside a subdirectory of an Obsidian Vault, require the same inherited `root_control_files_only` policy. Do not treat the absence of a local `.obsidian` marker as permission to read sibling note bodies.

Require `source_changes: []`. Report `content_files_read`, `content_bytes_read`, `truncated`, and access errors. If Inspect cannot distinguish internal roles, report that gap; do not fall back to repeated Portfolio/Bootstrap scans. A later move or repair still requires a separate reviewed Evolution or Guarded workflow.

## Bootstrap

Scan only a root the user explicitly placed in scope. Start with `--scan-mode structure`: it reads paths, file types, sizes, and modification times without opening file content or calculating content hashes. Use `--ignore` for known caches or generated directories. Do not present structure-only Predictions as confirmed defects.

Use `--scan-mode metadata` only after the user authorizes content hashing and Markdown metadata reads. It hashes every non-ignored file and reads up to 2 MiB from each Markdown file for titles, property names, tags, and links; it still must not send the whole corpus to model context.

After Scan, request `bootstrap context`; it is a bounded structural summary with no file bodies. Use Agent reasoning only when the deterministic Contract leaves a material uncertainty. It may propose project boundaries, folder or artifact roles, candidate naming/routing rules, and structural improvements. Inspect body content only for a specific unresolved judgment and only from the smallest relevant file set. Write proposals as JSON under Atlas runtime state, then submit them with `bootstrap propose`; never invent affected paths that were not observed by that scan.

Before inventing a structure, inspect `bootstrap profiles` and request `bootstrap contract`. The four bundled Profiles cover mixed-minimal, personal knowledge, project work, and research/writing libraries. Present `contract.review_card` by default: one short header, its `directory_map` as a `path → kind → note` table, proposed additions/adjustments, and only its unresolved questions. Mention `technical_exclusions` in one compact line; they stay in place and are not content zones. If `quality.status` is `needs_refinement`, resolve the listed unclassified directories or loose root files before asking the user to adopt. Keep Scan ID, Contract ID, fingerprint, confidence, evidence, full zones, and full routes in a collapsed technical appendix unless the user asks. Never paste the complete Contract as the confirmation card. A Contract must have `source_changes: []`; it never authorizes directory creation or source migration.

Preserve the user's naming language and established conventions. Observe script/language, numeric prefixes, separators, date formats, casing, and recurring role words from structure-only evidence. Reuse accepted local names instead of translating a Chinese library into an English template. Submit a reusable Naming preference only through the Effective Preference Rules workflow below; never silently batch-rename existing paths for consistency.

Ask once before `bootstrap adopt`, using the exact `contract_id` the user saw. Adoption accepts the Profile evidence as one user decision and records unrelated unreviewed Predictions as `deferred`, not falsely rejected. If the Contract says `needs_input`, ask only its listed questions and do not adopt yet. Advanced Agent Predictions may still be reviewed individually when the user explicitly wants them included. Keep Predictions distinct from Observations, Labels, and PolicyDecisions. Adoption writes maps, classifications, the Contract, and an accepted environment RuleVersion under Atlas state; it must not move, rename, create, or rewrite source files. Never relabel an initialized scan; use `bootstrap scan --new` for another version. Applying a structure suggestion to the target requires a later governed workflow.

## Effective Preference Rules

Use `rule context` after bounded Inspect/Bootstrap facts and before an Intake, Task, organization, or project-inspection decision that may reuse user habits. The request names the operation, stable Project when known, task dimensions, and only the rule kinds currently needed. Atlas returns active matching rules, conflicts, gaps, default advice, a context Hash, and a compact attention budget; it does not return rule history.

If status is `learned`, use the returned rules. If it is `advice_available`, the Agent may explain the exact Atlas default and propose it only if the user accepts that default. If it is `needs_agent_proposal`, inspect the smallest relevant `AGENTS.md`, README, manifest, directory role, or existing name evidence and submit one structured proposal. The Agent supplies semantic interpretation; Atlas validates evidence paths, scope, conditions, values, confidence, and impact.

Use `rule propose → rule preview → rule approve|reject`. Preview must show the current value, candidate value, changed fields, scope, and actual consumers. Ask once for that rule change. Approval creates an immutable RuleVersion and supersedes only the active rule with the same root, scope, kind, and condition. Never translate one task-local exception into a Project or Library rule without explicit scope approval. Existing Task or Intake runs must stop when their effective context Hash changes.

Kinds are `naming`, `placement`, `directory_role`, `storage`, `content_versioning`, `project_type`, and `agent_output`. Scope is `artifact`, `project`, or `library`. Use `rule active` for current behavior and `rule history` only for explicit audit; do not load history during ordinary tasks.

## Portfolio

Use `portfolio inventory` only on a disk/root the user explicitly authorized. The first pass uses depth 1. Depth 2 is allowed only with exact `--expand` directories selected from the first result; never expand software, cache, runtime, package-store, backup, junction, or unknown branches just to gather more evidence. Exclude known backups such as the user's `_backup` root exactly. Portfolio reads names and filesystem metadata only and must report `content_files_read: 0` and `content_bytes_read: 0`.

Treat root type and relation as separate Predictions. A Git marker proves a source repository boundary, not that it is user-owned tool source; an executable alone does not prove installed or portable software. Strong installer evidence may classify an installed application, but uncertain software remains `unknown` with candidate types. Never turn a name match, model guess, or “Pachin” substring into migration authority.

Show the compact root map, evidence, confidence, and unresolved entries. Record user corrections with `portfolio review`; do not encode them only in prose. Then use `portfolio plan` for a target workspace. The plan is read-only, has `source_changes: []`, and never authorizes movement. Installed/portable applications, runtimes, package stores, generated caches, backups, special paths, and unknown roots remain in place. A related reviewed repository/library is still blocked until its Git/Manifest and path-dependency report exists and a separately supported migration workflow is approved.

## Derived

Stage generated candidates with `work stage`, then use its `payload_path`; never write the Candidate into the governed root before execution. Use `derive recommend` to apply the active Profile, reviewed custom routing, input Project, role, and filename. Stop for unresolved/blocked results and surface missing-directory warnings instead of creating a directory.

Use `derive prepare` for a new generated file. Declare every existing input, one active Project, a supported closed V1 role, the new target path, and a lineage relation. The target must be absent, have a real existing parent, and remain inside the selected Project. Prepare captures managed Work and marks it `captured`.

Preview the Candidate Diff, placement Prediction, route policy, input hashes, role, and destination. Obtain explicit user approval for that placement before `derive execute`. Execution must stop if an input changed or another process claimed the target. If rejected, use `derive revise` for a new immutable Candidate and request approval again. After execution, verify the output Artifact/Material and lineage receipt. Use `derive promote` only for an allowed role transition such as draft to canonical; it must not change Material or path. The output may be an input to a later Derived run. Rollback removes only the exact recorded output version and must stop on later edits or active downstream runs; lineage remains in the Ledger as history.

Use `storage status`, then `storage plan`, before any `storage execute`. Never delete staged Work, referenced blobs, Ledger, backups, Inbox, or source files. An expired staged item is a warning, not cleanup authorization.

## Analytics Export

Use `analytics export --json` to measure Atlas usage, rule reuse, confirmations, failures, recovery, selected input bytes, or Token-related cost. The Node Runtime reads one consistent Ledger snapshot and writes versioned `records.jsonl`, `records.csv`, and `manifest.json` under the installed state directory. Treat the export as local private data.

Python or another analysis tool may read only the returned export directory. Do not give it the Ledger path or user Library write access. Validate the manifest and file Hashes before analysis. Do not send the whole export to the model when a local summary or bounded query is enough. Python is optional; missing Python must not block Atlas file governance or Node export.

## Task Contract

Use Task Contract as the preferred handoff to writing, summarization, analysis, PPT, website-content, or other content-production Skills. Before opening bodies, call `task discover` when the user or Agent does not already have an exact candidate list. Bound discovery by stable Project ID, role, extension, modification time, and maximum count. A stable explicit Project permits project-scoped structural discovery without adopting a whole-Library Contract; active Profile routes are used only when present. It reads structure rather than file bodies and includes registered Artifact/Material/lineage context when available.

Create a small JSON request under Atlas runtime state containing the intent, stable Project ID, explicit candidate inputs and/or the same bounded `discovery` criteria, optional series/date coverage, a read budget, and one output target/role/data class. Run `task prepare` before opening input bodies.

Inspect `data.attention` together with `data.read` and `data.write`. A reviewed `content_versioning` rule may select the `auto` write strategy. Do not query the entire RuleVersion history. If the effective context changes after prepare, discard the stale Task and prepare again.

For a cumulative timeline, rolling summary, ledger narrative, or other time-based existing document, inspect its declared source index or manifest before extending the date range. Build one compact coverage map from source-native message timestamps or an existing structured source list. File creation time, modification time, export time, and arbitrary date strings inside message bodies do not prove content coverage. Preserve uncovered periods as explicit gaps; do not invent continuity. Prefer a reviewed merged/superseding source over its older duplicate, and read only the missing periods or themes. Complete this coverage check before preparing the one Guarded Candidate so the user receives one meaningful approval rather than repeated partial reviews.

Read only `data.read.selected`; never open `read.excluded` merely because the Agent believes it may help. Atlas may exclude byte-identical copies or an older snapshot only when the newer file's declared coverage contains it and its bytes were deterministically verified. Partial or unverified overlap keeps both. If status is `needs_input`, ask only the returned bounded question; if `blocked`, do not generate or write.

When two different Materials declare the same series but one or both lack reliable coverage, require `temporal_relations[].type=coverage_unknown` and `decision=preserve_both`. This is a usable safe result, not a reason to invent dates or ask the user for metadata they do not have. A reviewed content-versioning rule may still choose the new output strategy, while both source Materials remain selected and preserved.

For binary inputs such as PPTX, DOCX, PDF, images, audio, and video, `estimated_tokens` counts only directly readable text inputs. Treat `requires_local_extraction` as a handoff requirement, not a request to send the binary or every rendered page to model context. Extract text, objects, metadata, or media facts locally first and give the Agent a compact difference or evidence set. For presentation comparison, render no slides by default. If structure and extracted text cannot settle a visual question, render at most eight representative slides as compressed 768×432 JPEG images. Text accuracy comes from local extraction, not image OCR. A final delivery QA pass is separate and may inspect the finished artifact under the content Skill's own rules.

Generate the Candidate outside the governed root. Confirm the returned `registration` contract before handoff. For an absent target, `task fulfill` reuses the user's current content-task authorization to run Derived and returns completed lineage without a redundant placement question. For an existing append-only target it stages a Guarded Candidate and returns `needs_approval`; show that exact Diff once, then use Guarded approve/execute and `task complete`. Atlas serializes creation of the one underlying write run across processes; do not create a replacement run after a claim conflict—reconcile with `task show`. When a content process has no enforceable sandbox, wrap its authorized write area in Tracked Direct and treat any scope violation as a failed handoff.

For `archive`, call `task archive-plan`, inspect the linked immutable organization plan, and obtain one approval before Evolution execution. Archive is a retained move, not deletion. Delete, arbitrary overwrite, multi-target content write, or reading beyond the Contract remain unsupported. Use `task show` to reconcile, and `task rollback` only when recovery is requested. Any selected-input, Project-path, or active Library Contract change makes the Task stale.

## Intake

For a user-authorized URL import, do not return a full DOM snapshot, body text, embedded application state, or complete Diff to model context. With the controlled in-app browser tab already on the exact page, import `scripts/capture-browser-page.mjs` in the browser's local Node session and call `captureBrowserPage({ tab, stateDir, mode })`. Use `selection` when the user selected exact text, `chatgpt_share` for a ChatGPT share page, and `page_text` only when the whole identified page is the requested input. The helper writes `.atlas/tmp/*.browser-capture.json` directly and returns only metadata.

Pass the returned `capture_file` to `atlas capture localize --input-file <path> --json`. It cleans text locally, formats supported message records, stages one managed Work Candidate, and returns counts, Hash, bytes, `completeness`, `work_id`, and `candidate_path` without the body. Treat `completeness=not_proven` as a real limitation; rendered DOM is not proof that a lazy or virtualized page was captured in full.

Use `atlas capture sample <work_id> --start-character <n> --characters <1..4000> --json` only for the smallest excerpt needed for semantic classification or analysis. Do not loop through the whole document by default. Then pass `candidate_path` to Intake. Do not call `intake show` after a successful execute.

When the current task includes an attached local file, take its supplied path as the Candidate and set `origin=human_submitted` without asking the user to repeat the path or describe the origin. The Agent—not Atlas—must interpret the user's request and read the smallest necessary attachment content, then combine that semantic judgment with Atlas file facts, active Projects, and accepted routing rules to propose `kind`, `project`, `role`, and `target`. Atlas validates and executes that structured proposal; it does not infer natural-language intent. When an Agent is about to create a durable output, the Agent proposes its purpose and Project, then obtains a validated staging/final placement through Task Contract or Intake before writing; do not invent a project source-directory path for convenience. The user-facing response should normally be one receipt stating the selected Project, stage, and destination—not a request for internal protocol fields.

When the current task already supplies one exact attachment, Project, absent target, intent, and execution authorization, call `scripts/intake-attached-file.ps1` instead of rebuilding the PowerShell/JSON sequence. Pass either the stable Project ID or the exact Project name/path; use `-CreateProjectIfMissing` only when the Agent has already established that missing Project identity. The script performs the Runtime handshake, exact Project reconciliation, direct Intake prepare/execute, final Hash check, and one compact receipt. Do not call `work stage` first for an attached local file: Intake captures the external Candidate itself. Stop on the script's unresolved or failed receipt rather than retrying commands by hand.

The current Runtime still requires explicit CLI fields internally. The Skill must fill fields supported by observed task context and accepted rules, but must not pretend a unified automatic placement API exists. If no single active Project or route can be proven, ask only that unresolved question and record the correction for reuse.

Intake returns `attention`; a reviewed `placement` preference can supply role and Project-relative target subdirectory without an active whole-Library Contract. The Agent still supplies the semantic kind and filename when they are not already known. A later matching Intake reuses the same preference without another placement question. A changed effective-context Hash invalidates a prepared Intake.

When the Agent has one exact destination from the current task and existing structure, pass both `--project` and `--target`. Atlas validates that the new target is absent, has a real existing parent, remains inside the authorized root and selected Project, and can execute without forcing adoption of an unrelated whole-library Contract. This is a task-scoped placement, not a learned global routing rule.

Use `intake prepare` with exactly one origin: `human_submitted`, `human_written`, `agent_generated`, or `download`. Supply a known kind when available; otherwise let the origin default to `raw_input`, `note`, `intermediate`, or `source`. The V1 convenience kinds `code` and `demo` remain `intermediate`; `asset` remains `source`. Atlas preserves both the user-facing kind and Foundation role in the placement Prediction.

For a batch, call `intake batch-plan` before creating runs and ask only the coalesced unresolved questions. When the user corrects a route, use `intake correct` with the narrowest intended scope: `artifact`, `project`, or `global`. Preserve the returned RuleVersion and let later matching Intake reuse it; do not encode the correction only in Agent prose.

For a ready plan with `auto_execute: true` and confidence at least `0.9`, execute without asking a second file-placement question when the user's current task already authorizes organizing that file. Pass that task authorization as `--reason`. This still records a Label, PolicyDecision, Artifact, Material, origin/kind context, and rollback route. If Atlas returns `needs_input`, `blocked`, a route conflict, or an unknown kind, stop and ask only the returned bounded question. For `needs_structure_change`, present the exact missing area and use a separate Evolution directory plan only after the user approves that structure change; then prepare Intake again. Never choose among multiple Projects silently.

The Candidate must stay outside the governed root until execution. Intake creates one new file and never overwrites, moves, or deletes. It may have zero related inputs for an original submission/download, or explicit `--input` paths when lineage exists. After a successful execute, verify the compact execution receipt and target Hash; do not call `intake show` merely to repeat a successful result because it includes the complete Diff. Use `intake show` after a timeout, ambiguous result, conflict, or explicit audit request. Rollback must preserve the external Candidate and refuse later target changes.

## Project Evolution

Treat a Project ID as the stable identity and its name/path as changeable views. Use `project evolve` when a category meaning expands, narrows, pauses, or is archived. A rename automatically retains the prior name as an alias and returns `source_changes: []`; this is how “就业” can become “就业与生活” without a forced folder move. Use `project create --split-from` and `project merge` to preserve split/merge lineage rather than deleting old identities.

`project move` updates Registry history only; it does not move a directory. Never call it before a separately governed physical migration has completed and been verified.

Use top-level `evolve` for one physical operation:

- `create_directory`: create one absent directory whose real parent already exists.
- `move_file`: rename one existing regular file to one absent target under the same authorized root.
- `migrate_project`: move the current registered Project directory to one absent target, verify its complete manifest, then update Registry.
- `migrate_directory`: move one governed library or workspace directory to one absent target under the same filesystem, after Atlas inspects its control files and path dependencies. Atlas reports and rebases in-tree Junctions without following them.
- `remove_empty_directory`: remove one existing real directory only when it contains no entries; rollback recreates it only while the path remains absent.

Always run `evolve prepare`, inspect `evolve preview`, and show the exact source changes, manifest summary, risk, and recovery route. For a Library migration, also reconcile `generated_caches`, `package_manager_environment`, every reparse point's `target_exists`, and `recommendation`; never treat a detected cache as durable Library content. Obtain explicit approval for that plan before `evolve approve` and `evolve execute`. Preparation or approval is invalid if the source manifest, target absence, Project Registry path, or plan changes. Recovery must stop if later files appeared, content changed, the original path was reclaimed, or Registry evolved again. `remove_empty_directory` is not authority to delete files or non-empty directories. Do not use Evolution for overwrite, merge/split batch migration, cross-filesystem movement, case-only rename, a source path reached through a symbolic link, or unsupported special entries. `migrate_directory` may preserve and rebase only the in-tree reparse points explicitly reported by Preview.

For one reviewed organization scenario, `evolve plan-prepare` may combine those implemented operations under one immutable plan and one approval. Use `evolve plan-reject` when the plan or its inspection evidence is no longer acceptable. Do not execute an older prepared plan after Atlas inspection rules change; reject and rebuild it.

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

After approval, call `guarded apply-approved <run_id> --reason <current_user_approval> --json` to record the approval, revalidate state, execute exactly that Candidate, and return one compact verified receipt. A changed target invalidates approval; preview or revise again. Rejecting or revising must preserve the previous Candidate ChangeSet. Rollback must stop rather than overwrite later legitimate changes.

Treat explicit approval of an already-previewed Candidate as a fast path: call only `guarded apply-approved`, then return its compact receipt. Do not repeat Inspect, Preview, source reads, tests, repository Git checks, documentation updates, architecture work, broad status queries, or a separate final Hash command unless the fast-path command fails, reports a conflict, or verification is false. Report `elapsed_ms`; treat `within_10_second_budget=false` as an execution-latency issue. A rolled-back run cannot be replayed through this command. Development maintenance belongs to a later checkpoint and must not block the user's content operation.

V1 Guarded execution supports only updating one existing regular file. Evolution separately supports the exact operations advertised by `capabilities`. Do not imply support for Guarded create, delete, move, rename, or batch execution.

## Report the Outcome

Return a short human summary containing the selected mode, run ID, actual changed paths, policy result, verification result, and recovery availability. Surface conflicts, violations, unresolved Predictions, and unsupported operations plainly. Do not call Fixture-only success production validation, and do not scan a real Vault without explicit authorization.
