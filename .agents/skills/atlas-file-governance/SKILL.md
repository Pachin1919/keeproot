---
name: atlas-file-governance
description: Use the installed Atlas Runtime to operate on real local Workspace files or attachments: save/import, bounded content inspection, workspace organization, governed writes, context handoff, verification, and recovery. Do not use for Atlas source development, architecture discussion, Git inspection, documentation-only work, or ordinary test diagnosis.
---

# Atlas File Governance

Use Atlas for deterministic facts, supported file operations, relationships, verification, and recovery. The Host interprets meaning and creates content.

## Gate

- Invoke only for real Workspace material, not because Atlas is mentioned.
- For source development, architecture, Git, docs, or test diagnosis, follow repository instructions without loading Runtime workflows.
- Stay within the authorized Project, root, files, and destination.

## Start once

Run `scripts/locate-atlas.ps1` once with a 15-second timeout. On `runtime_required`, stop and recommend `install-atlas.ps1 install`. Use only the returned `launcher_path`; reuse it for the task.

## Route

Read only the matching reference:

- Inspect one real Resource or compare two files: `references/current-resource.md`.
- Save/import a new result, then verify, undo, or redo it: `references/current-save.md`.
- Unfamiliar JSON or unresolved Runtime errors: `references/cli-protocol.md`.
- UI only: `atlas ui`, or `atlas ui --path <EXPLICIT_PROJECT_PATH>`.

Never fall back from Resources, Import, Data Work, Save, or Activity to an internal foundation command. Finding an old database row is not authorization. Report unsupported current behavior instead.

For structured content, inspect locally first. Let Atlas determine spreadsheet structure, PDF page kind, and PPTX/DOCX objects; do not ask the model to count rows or rediscover facts.

## Execute and stop

- Use active Project rules and caller fields.
- Stop on `deny`, `setup_required`, `stale`, `conflict`, or unsupported work. Do not bypass Atlas.
- Use one review path; after approval, run only its bound action.
- Never overwrite a conflict. Use recorded recovery when available.
- For recurring cross-Project work, reuse one reviewed Context Link rather than rereading unchanged source bodies.

## Report

Report the action, useful result, verification, recovery, and one limit. Omit raw JSON, Ledger history, hashes, IDs, and bodies unless diagnosing. Do not claim Token savings without comparable data.
