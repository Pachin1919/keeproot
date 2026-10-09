# Keeproot

**A local workspace for materials, repeatable work and AI collaboration.**

Keeproot keeps files in their existing project folders. People and AI hosts use the same resource identities, work revisions, saved results and recovery state. The host understands content and proposes changes; Keeproot checks local facts and executes supported operations.

Current version: **2.0.0-preview.1**. This is preview source, not a stable release. Atlas remains the technical name used by the CLI, protocol, Skill and installation directories.

## What you can try

- Browse and read Markdown, text, images, PDF, DOCX and CSV/XLSX in the workspace.
- Run a Python table-processing recipe: align columns, combine sources, filter, convert types, deduplicate and sort; preview and save the full result.
- Calculate grouped sums, two-axis pivot totals/shares/ranks, and monthly totals with period growth. [Processing implementation and limits](<docs/Atlas 技术作品与企业评审说明.md#python-processing>).
- Reuse a work configuration with explicitly selected new sources; review source changes.
- Follow recorded source/result relationships, compose a Board and export supported content.
- Capture supported public pages or selected conversation exports; review local updates.
- Prepare bounded handoff context and restore supported, explicitly protected work scopes.

## First trial: no personal documents or AI account needed

Use Windows, **Node.js 24+** and a trusted **Python 3.11+** installation. Download this repository or clone it, open PowerShell in that folder, and run:

```powershell
.\start-preview.ps1 -InstallRoot (Join-Path $PWD 'preview-install') -Install -PythonPath 'C:\Path\To\python.exe'
```

Replace the Python example with your own interpreter path. Use an unused installation directory outside your real projects. First installation downloads the required Python packages and creates an isolated environment. It does not install a user AI Hook or connect an AI account.

The script prints a local page address. Open it and follow the [five-step trial guide](<docs/Atlas V1 验收指南.md>). The prepared sample contains two fictional CSV inputs. Saving a new result preserves those inputs and earlier results. Reopen the same sample with:

```powershell
.\start-preview.ps1 -InstallRoot (Join-Path $PWD 'preview-install')
```

Ctrl+C stops this page server and preserves the sample. This entry opens an HTML work surface; it does not automatically launch the native window.

## Limits and privacy

Windows installation and representative HTML workflows have been exercised. Native display scaling, different-product AI continuation, first use on other computers and real-project acceptance still need validation. Two optional Host experiments are included but disabled by default; their real account/Hook flows are unverified. There is no cloud synchronization or general AI engine.

State and snapshots stay local. Explicit URL capture contacts the selected site; package installation uses the configured package source. External AI hosts have their own data handling. Trusted local Modules run with the process account's permissions and are not a sandbox. See [usage, networking and component notices](<docs/Atlas V1 使用说明书.md>).

## Development and history

Node.js uses ESM, built-in SQLite and `node:test`; Python handles local document and table processing. No npm runtime installation is needed for the Node code. For tests, select the Python environment containing the pinned content dependencies:

```powershell
$env:ATLAS_CONTENT_PYTHON = 'C:\Path\To\python.exe'
$env:ATLAS_TEST_PYTHON = $env:ATLAS_CONTENT_PYTHON
npm test
```

The retained Git history starts on **2026-07-20**. Internal development documents and machine-specific records were removed from every published revision. Original commit dates, branch relationships and version tags are retained; hashes changed during this cleanup. Older branches represent earlier implementations, not the current supported preview.

This repository is public source. A project-wide open-source license has not been selected; bundled third-party code retains its own licenses. Public source visibility does not grant a new license for original code or artwork. Keeproot name rights have not been cleared.

### Publishing changes

Known test limitation: the legacy navigation-layout regression still needs its resizer check scoped to the current DOM. The regression gate is not fully green. This does not change the preview's pending native, second-host and real-project validation.

Use a sanitized checkout for public updates. Do not merge private development history into this repository. Before committing, run `python scripts/check-public-source.py --worktree`; before pushing, run it without that flag. Enable the included local check with `git config --local core.hooksPath .githooks`. The hook uses Python from PATH or `ATLAS_PUBLIC_CHECK_PYTHON`. CI also checks all reachable history. The checks help detect excluded paths and common sensitive patterns; review public content before upload.

## Feedback

Use [GitHub Issues](https://github.com/Pachin1919/keeproot/issues). Include version/build, Windows display scale, steps, expected behavior and a redacted screenshot. Do not upload private files, credentials, chat archives or whole state databases.

[Product overview](<docs/Atlas V1 产品说明书.md>) · [Usage](<docs/Atlas V1 使用说明书.md>) · [Architecture and evidence limits](<docs/Atlas 技术作品与企业评审说明.md>)
