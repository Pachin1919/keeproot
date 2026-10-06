---
name: atlas-file-governance
description: Use the installed Atlas Runtime for real local Workspace files or attachments: save/import, bounded inspection, organization, governed writes, verification, and recovery. Do not use for Atlas source development, architecture, Git, docs, or ordinary test diagnosis.
---

# Atlas File Governance

Atlas supplies facts, supported operations and recovery; Hosts interpret meaning and create content.

## Gate

- Invoke only for real Workspace material.
- Development, Git, docs and tests follow repository instructions.
- Stay within the authorized Project, root, files, and destination.

## Start once

Run `scripts/locate-atlas.ps1` once with a 15-second timeout. On `runtime_required`, stop and recommend `install-atlas.ps1 install`. Reuse only the returned `launcher_path`.

## Route

New Hosts or unfamiliar operations: read `capabilities --json` once. `data.product_entrypoints.current_product.command_guide` gives inputs, outputs, failure steps and examples; `atlas --json` gives matching syntax. Use this installation's facts.

Read only the matching reference:

- Inspect one real Resource or compare two files: `references/current-resource.md`.
- CSV/XLSX processing Work: `references/current-table-work.md`.
- Save/import a new result, then verify, undo, or redo it: `references/current-save.md`.
- View writes, property suggestions or conversation Save: `references/cli-protocol.md` and `references/workflows.md`.
- Unfamiliar JSON or unresolved Runtime errors: `references/cli-protocol.md`.
- Handoff, local Modules, Project move/split/merge and document updates: use the guide's read-only discovery, then exact mutation syntax.
- UI only: `atlas ui`, or `atlas ui --path <EXPLICIT_PROJECT_PATH>`.

Never fall back to internal foundation commands. Old database rows grant no authority; report unsupported behavior.

Saved Views are read-only and dynamic; partial/unknown is not complete or unchanged. Submit at most 10 evidence-backed property candidates for one explicit View or Resource set. Preview values require user accept/edit/reject in UI.

For structured content, inspect locally first: spreadsheet structure, PDF page kind and Office objects; do not ask the model to count rows or rediscover facts.

## Execute and stop

- Use active Project rules and caller fields.
- Stop on `deny`, `setup_required`, `stale`, `conflict`, or unsupported work. Do not bypass Atlas.
- Use one review path; after approval, run only its bound action.
- Never overwrite a conflict. Use recorded recovery when available.
- For recurring cross-Project work, reuse one reviewed Context Link rather than rereading unchanged source bodies.

## Report

Report the action, useful result, verification, recovery, and one limit. Omit raw JSON, Ledger history, hashes, IDs, and bodies unless diagnosing. Do not claim Token savings without comparable data.
