---
name: atlas-file-governance
description: Use the installed Atlas coordination Runtime for bounded Workspace facts, file intake, local document/data processing, governed writes, verification, and recovery. Trigger for Atlas, attached files, rollback, workspace organization, durable Agent outputs, and Excel/CSV/PDF/PPT/DOCX work.
---

# Atlas File Governance

Atlas is the local coordination Runtime between User Intent, Execution Host, and Local Workspace. The Host interprets meaning and creates content; Atlas maintains bounded facts, supported file operations, verification, and recovery. Desktop and Host are ports into the same Runtime.

## Fast start

Run `scripts/locate-atlas.ps1` once with a 15-second timeout. On `runtime_required`, stop and recommend `install-atlas.ps1 install`. Invoke its `launcher_path`, never `bin/atlas.js` directly; reuse that installed-state launcher for the task. Do not repeat successful discovery or source inspection.

Use the shortest applicable route:

- Exact attachment with known destination: Intake fast path; several: one `intake batch-execute`.
- Spreadsheet, PDF, PPTX, DOCX, webpage, or chat: one local content command before any model reading.
- Subagent handoff: the primary Agent selects confirmed context into `atlas.conversation-selection.v1`; Atlas writes one new Project Markdown with `content localize-conversation`. Never pass the raw parent conversation.
- Workspace organization requested by the user: start with one `bootstrap scan --scan-mode structure`; do not repeat it when targeted control-file inspection is needed.
- Ordinary edit: `begin → Agent edit → close`; important update: `agent prepare → one UI review → approve/apply`.
- New declared output: Task/Derived. Supported move or directory change: Evolution. Recovery: the recorded rollback command; never overwrite a conflict.

Read `references/workflows.md` only for exact syntax and `references/cli-protocol.md` only for a new integration or error.

Open Atlas with `atlas ui`; open a current Project with `atlas ui --path <EXPLICIT_PROJECT_PATH>`.

## Local-first content path

Before sending bodies or images to a model, use local work:

- Spreadsheet: `atlas content inspect --purpose data`; inspect Sheet names, merged headers, types, missing values and duplicates. Do not ask the model to count rows.
- PDF: extract the text layer and image-only page list. Render only unresolved visual pages.
- PPTX/DOCX: extract text, notes, objects, and structure before preview.
- Public static page: `capture fetch`. For login-only/client-rendered pages, ask for an export or selection.
- Chat versions or branches: `content compare` or one `content branches` call. Read each deduplicated segment once.

Host `content inspect` must include caller fields in `workflows.md`; add `--project` only for a file inside that Project. Success updates Desktop Recent Work without copying the result or creating permanent history.

Use `--compact` only for repeat status/reuse. Do not call a model to prove local processing; report the local result and limits. For data work, stop after preparation until the user continues.

## Project context

Use injected Project context when present; otherwise one `agent context` or `project resolve`. Use active rules only. For recurring cross-Project work, reuse a reviewed Context Link; Atlas freezes inputs and write boundary.

## Writes and review

Keep IDs internal. Stop on `deny`, `setup_required`, `stale`, `conflict`, or unsupported work. Do not bypass Atlas. Use a single review path; after approval run only the bound action and report verification.

## Report

Return what changed/was inspected, useful result or review, verification, recovery availability, and one unresolved limit. Omit Ledger history, full JSON, Diff, hashes, IDs, and bodies unless diagnostics are requested. Do not claim Token savings without comparable host usage data.
