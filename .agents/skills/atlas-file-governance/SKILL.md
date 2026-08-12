---
name: atlas-file-governance
description: Use the installed Atlas local Runtime for project identity, bounded file intake, cross-project context, local document or spreadsheet facts, governed Agent writes, verification, and recovery. Trigger for attached files, project/workspace inspection, Atlas, rollback, Vault organization, Excel/CSV/PDF/PPT/DOCX, or durable Agent outputs.
---

# Atlas File Governance

Atlas is the deterministic local control layer. The Agent understands meaning and writes content; Atlas resolves Project/Root identity, returns active rules and bounded facts, validates paths, executes supported changes, verifies Hashes, and protects rollback.

## Start once

Run `scripts/locate-atlas.ps1`. It checks the installed Runtime directly; do not scan the target or disk for Atlas. If it returns `runtime_required`, stop and recommend `install-atlas.ps1 install`.

Set process-local `ATLAS_HOME` and `ATLAS_STATE_DIR` from the locator result. For the first Atlas call in a task, require the `atlas-cli.v1` JSON envelope and use a 15-second timeout. Do not repeat `version`, `capabilities`, and `doctor` for every file in the same task. Read [references/cli-protocol.md](references/cli-protocol.md) only when constructing a new command or handling an error.

When the SessionStart Hook identifies a managed Project, use its injected Task status. If it reports idle, do not call `agent status` again. If it reports one pending Task, resume that exact ID before starting another. If Hook output is absent, use `agent context` or `project resolve`; do not repeat shallow scans.

Codex Desktop auto-context uses a reviewed project-local `.codex/hooks.json`; the Atlas Runtime and Ledger remain user-level. Do not tell the user to type `/hooks` into chat. If the exact Project Root has no trusted Atlas hook, report that setup fact once and continue through the ordinary Skill path.

When the user asks to open Atlas or control Tasks visually, start `atlas ui --path <CURRENT_WORKING_DIRECTORY> --no-open` and return its loopback URL. The Workspace lists managed Projects and Tasks; the user opens a Task without copying its ID. The server listens only on `127.0.0.1`, can be stopped from the Workspace, and calls existing Atlas services for actions. Omit `--no-open` when the user launches Atlas directly and wants the default browser opened.

`ui context --path` and `ui operation --task` create audit Snapshots, not interactive UI. Use them only when the user asks for a saved, read-only state. They remain under Atlas state and must not be copied into the user project.

When the user asks whether a persistent cross-Project Task still uses current sources, add `--refresh-sources`. This refreshes only the Projects in that Task's Source Set and hashes only the selected files. Do not add it to ordinary page opens or Tasks without a Source Set.

When the user wants to open one known Task directly, add `--task <TASK_ID>` to `atlas ui`. Add `--refresh-sources` only when the user asks to recheck a persistent Source Set. Atlas revalidates the Task, write run, ChangeSet, Candidate/Diff Hashes and existing review before every action. Execute and rollback require an explicit confirmation in the page. Do not replace the action bridge with a button that runs an unbound CLI string.

## Choose the shortest path

The main routes are **Intake**, **Task Contract**, **Tracked Direct**, **Guarded**, and **Evolution**. Choose only one route for the current operation.

- Exact attached file plus known Project and absent target: use **Intake fast path**.
- Two or more authorized attachments with known targets: use one `intake batch-execute`; never run the single-file script once per attachment.
- Attachment semantics affect placement: run one local `atlas content inspect`, then Intake.
- Public static webpage: use one `atlas capture fetch`; for login-only or client-rendered pages, ask for an export or explicit selection instead of repeatedly driving a browser.
- Read-only project diagnosis: use `inspect`.
- Existing library recognition or optional structure advice: use Bootstrap `--scan-mode structure`.
- Recurring cross-Project work: reuse Root, Project Location and Context Link; do not scan sibling roots ad hoc.
- Ordinary narrow edit: Tracked Direct.
- Important existing-file update: `agent prepare`/Guarded and one review through `review_path`.
- Generated new output with selected inputs: Task Contract or Derived.
- Supported directory create/move/migration, including one exact cross-Root file or directory: Evolution.
- Recovery request: use the recorded Task/Run rollback; never overwrite a later-change conflict.

Read only the matching section of [references/workflows.md](references/workflows.md). Do not load unrelated workflows.

## Attachment fast path

Treat a supplied attachment path as `human_submitted`. The Agent supplies semantic `kind`, Project and target from the task and current rules; Atlas validates them.

For one exact attachment, use `scripts/intake-attached-file.ps1` only when Project and target are already known. It performs the whole placement and returns one compact receipt. Do not call `intake show` after verified success.

For multiple attachments, write one request under Atlas state:

```json
{
  "items": [
    {
      "candidateFile": "C:/attachments/report-april.pdf",
      "origin": "human_submitted",
      "kind": "report",
      "projectId": "PRJ-...",
      "target": "ClientCampaign/Reports/monthly-report-april.pdf",
      "intent": "Keep the submitted monthly report."
    }
  ]
}
```

Call once:

```text
atlas intake batch-execute --root <ROOT> --request-file <JSON> --reason <USER_TASK_AUTHORIZATION> <caller metadata> --json
```

The command preflights every item, creates and verifies all ready targets in one Runtime process, and returns all run IDs and rollback entries. If any item needs classification or a target, stop before execution and ask one combined question.

## Attachment-dependent structure decisions

“Environment setup only” does not prohibit read-only structural inspection when the attachment determines the structure. Run `atlas content inspect --file <EXACT_PATH> --purpose <structure|content|data|visual> --json` before proposing folders.

For spreadsheets, inspect worksheet names, used ranges, relevant headers, and merged or multi-level header structure. Use `purpose=data --sheet <NAME>` for Pandas/SQLite quality facts without raw rows. For PDF, use the text layer and image-only page list before screenshots. Do not launch a browser, Office, or rendering flow when local extraction is sufficient.

For a captured chat, keep the readable Markdown Candidate and the returned message-level JSONL Work item. Use `content compare` on two versions. For two or more branches of one conversation, use one `content branches --file ...` call and read each returned segment once; do not reread duplicated prefixes.

## Project and rule context

Project ID is stable; names and locations can change. If a known Project has no Location, adopt the authorized Root once and attach the Project once. Use `root relocate` or `project relocate` only for a user-supplied exact new location; Atlas does not search disks or move files through those commands.

Use current active rules, not rule history. The Hook may inject a few Project-scoped placement rules. If Atlas has no rule, the Agent proposes one from minimal control-file evidence; only explicit user approval creates a reusable immutable RuleVersion.

For recurring cross-Project work, reuse the reviewed Context Link and use bounded `task discover-context --compact`. The Agent chooses relevant candidates; Atlas freezes the Source Set and restricts writing to one target Root.

For a physical cross-Root move, use `migrate_cross_root` with explicit source and target Roots. Atlas copies to a technical sibling stage, verifies the full Manifest, atomically claims the target inside its Root, and removes the source last. Do not use PowerShell as the mover. If the entry is a registered Project, run `project relocate` after verified execution; if identity reconciliation fails, roll back the Evolution run instead of editing Registry paths manually.

## Writes and approval

Use exact paths and caller metadata. Save returned IDs. Stop on `deny`, `setup_required`, `stale`, `conflict`, or unsupported operations; do not bypass Atlas with PowerShell.

For an important update, `agent prepare` returns one review path. After explicit approval, call `agent approve`, preserve its `approval_token`, then call `agent fulfill`. Do not repeat Inspect, Preview, source reads, broad tests, Git checks, or another Hash command after a verified fast-path receipt.

For a normal edit, use `begin → Agent edit → close`. Require `policy=pass`. Use rollback only when requested; it must stop if the current file no longer matches the recorded end state.

## Report

Return one short receipt: Project, changed targets, verification, elapsed time, and rollback availability. Mention unresolved or unsupported items plainly. Do not paste full Ledger history, complete Diff, file bodies, or internal command output unless requested.
