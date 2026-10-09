# Keeproot product overview

Preview: 2.0.0-preview.1.

Keeproot is a local project workspace. It helps a person and an AI host find materials, continue work, save results and inspect changes. Original files stay in project directories.

| Object | Meaning |
|---|---|
| Project | A registered local work directory |
| Resource | A file identity with recorded location and version facts |
| Work | Supported processing with explicit sources, configuration and revision |
| Result | A file saved and verified through the shared Save service |
| Board | References, explanatory text and result previews |
| Handoff | Selected context and current work state for a new host |

## Current operations

- Read common local formats inside the workspace; complex editing remains in external tools.
- Process explicitly selected CSV/XLSX sources, align fields, preview a deterministic recipe and save CSV/XLSX results.
- Reuse compatible mappings with new, explicitly matched sources. New work and results preserve earlier ones.
- Review source changes and follow stored Source → Work → Result → Board relationships.
- Capture supported public pages and structured conversation exports. Unsupported or login-only pages require an accessible export.
- Apply supported reviewed text changes with version checks; this is not semantic editing by Keeproot.
- Manage supported same-root project evolution, subject to dependency and path checks.
- Protect an explicit supported scope, preview recovery and return from a mistaken restore. This does not restore an entire computer or an AI conversation.

The AI host interprets meaning, proposes placement and generates content. Keeproot stores confirmed rules and deterministically validates operations. Candidate advice is not treated as user approval.

## Known limits

This preview is not broadly validated. Different-product host continuation, real account/Hook experiments, native scaling and real-project acceptance remain open. There is no general editor, AI scheduler, arbitrary-code sandbox or cloud collaboration system. Recovery cannot cover undeclared dependencies, unsaved external editor buffers or remote services. Original technical commands and directories remain Atlas.

Use the [fictional trial](<./Atlas V1 验收指南.md>) before selecting personal materials. See [usage](<./Atlas V1 使用说明书.md>) for installation and privacy.
