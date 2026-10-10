# Keeproot preview usage

Version: 2.0.0-preview.1. The command and installation format retain the Atlas technical name.

## Install an isolated trial

Use Windows, Node.js 24+ and a trusted Python 3.11+. Open PowerShell in the source directory:

```powershell
.\start-preview.ps1 -InstallRoot (Join-Path $PWD 'preview-install') -Install -PythonPath 'C:\Path\To\python.exe'
```

Replace the Python path. Select an unused install directory outside your real project or library. The installer creates managed Python environments and downloads the required packages. It does not enable a user Hook or connect an AI account. The local Skill is placed within this trial root rather than the user Host configuration.

Open the local address printed by the terminal. If the page is English, choose Settings → Interface language → 简体中文 → Save and close. Follow the [trial guide](<./Atlas V1 验收指南.md>).

The prepared sample contains two fictional CSV sources and a stored recipe. Save a new filename in `02_成果`, then read the result. It contains three values: 100, 80 and 20. Their arithmetic sum is 200; the recipe does not create a total row. Sources and earlier results are retained. Default filename format switching replaces the known extension rather than appending a second one.

## Toolbox: public URL to Markdown and table requirements

Choose a Project, then open Toolbox in the left navigation. Under Content conversion, enter a public URL, choose an existing folder and filename, then Preview. Confirm the content and destination before Save. Open the saved material and Read. Only directly readable static public pages are supported; authenticated/dynamic sources require the separate export workflow. Captured source metadata is expandable above the article; editing keeps the complete file.

| Table tool | Required inputs |
|---|---|
| Combine and clean | CSV/XLSX and aligned fields; joins need matching keys |
| Group and sum | A grouping field, numeric measure and unit |
| Pivot | Two distinct grouping fields, a separate numeric measure and unit |
| Monthly trend | Date field, numeric measure, valid month periods and unit |

Missing selections, invalid fields and nonnumeric measures stop the operation. Ordinary validation errors retain the current-revision form so you can correct it. A stale draft cannot overwrite a newer revision. Back to Toolbox/Read leaves the Work available and does not Save a result. UI drafts are process-local, not restart-persistent. New Markdown preparation retains its inputs on error; an interrupted pending request stays explicit rather than repeating a write. Inspect that Save record before submitting another request.

## Try a simple analysis

The prepared sample demonstrates combining and deduplicating, so it does not show an analysis summary by default. In Table Work, reuse the sample work to create a separate work, retain its column alignment and `id` deduplication, then choose grouped sum in the processing recipe. Use `region` as the dimension, `amount` as the measure, `sum` as the formula and an explicit unit. Set Sort field to No sort because `id` is not part of the grouped output. Save Recipe, then Preview before saving a new filename.

For the sample's three retained rows, the expected grouped result is North/北区 **120**, South/南区 **80**, total **200**. Empty-value exclusion and the number of included/excluded rows are shown with the result. Pivot and monthly trend have their own recipe controls and need the corresponding category/date columns; the prepared sample has no date column, so it cannot demonstrate monthly trend.

Changing the recipe changes a Work revision. The preview is not the saved result; save and read the new CSV/XLSX to check the delivered file. See [implemented operations and limits](<./Atlas 技术作品与企业评审说明.md#python-processing>) before asking a Host to run an analysis.

## Stop, reopen, upgrade and uninstall

Ctrl+C stops the HTML server. Reopen the same sample:

```powershell
.\start-preview.ps1 -InstallRoot (Join-Path $PWD 'preview-install')
```

To upgrade this same trial root from newer source, repeat the first installation command with `-Install`; an existing install manifest selects the upgrade operation. Back up important data before trying a new preview. Do not point this trial entry at an unrelated installed Runtime.

Uninstall using the same root and its Skill directory:

```powershell
.\install-atlas.ps1 -Command uninstall -InstallRoot (Join-Path $PWD 'preview-install') -SkillRoot (Join-Path $PWD 'preview-install/skill') -NoStartMenuShortcut
```

Uninstall retains state, demo samples and results. This command does not delete your project materials. The trial entry prints HTML; it does not automatically launch the native Desktop window.

## Reading and appearance

Double-click a supported registered file or select it and click Read. Markdown and text have an Edit text action in the same reading workspace; table materials have Process and analyse table. Complex editing is under More → External edit. Focused reading hides the side panels. Settings offers local UI/reading fonts, font size, line spacing and application scale from 85% to 125%. Saving exits Settings and returns to the originating page.

### Toolbox

Open Toolbox in the left navigation. Choose a Project, select registered CSV/XLSX materials, then choose Combine and clean, Group and sum, Pivot table, or Monthly trend. Start new Work or explicitly reuse compatible existing Work. Prepare sources and confirm column alignment; the selected tool's settings open next. Choose fields and a unit label (for example amount or count), save the recipe, preview, then Save to a new result file. Group and sum over the demo's combined result can produce North 120, South 80, total 200. Selecting a tool does not infer fields or silently execute it.

### Edit while reading

For MD/TXT, click Edit text, change the body, then Preview changes. The current file remains unchanged at preview. Save this text applies the displayed version to the same Resource; Undo text edit restores the earlier bytes when no later change conflicts. Cancel does not save the draft; the browser may ask before leaving unsaved text.

This editor accepts UTF-8 files up to 256 KiB, including empty text, and preserves the original BOM and uniform LF/CRLF endings. Serialized journal capacity can impose a smaller practical limit. Mixed line endings, links/aliases, identity changes, external edits and pending recovery can block writing. It uses the existing supported Windows transactional writer. PDF/DOCX/image layout editing is external; table processing produces a new result. Prepare AI handoff is a separate action for related Table Work and does not start an AI session or grant account/Hook permissions.

| Material | View and limitations |
|---|---|
| Markdown / text | Common tables, lists, quotes and code; raw HTML is escaped; remote images are not loaded automatically |
| PNG/JPEG/WebP/GIF | Local image view; executable SVG/HTML is not opened as a document |
| PDF | Embedded page rendering; encrypted, invalid and oversized files can be refused |
| DOCX | Extracted text and tables; no faithful Word pagination or full layout |
| CSV/TSV/XLSX | Pages of 50 rows and XLSX sheet switching; raw values and available formula caches; no formula calculation or Excel formatting |

Table reading limits include 10000 rows, 50 columns and 500 characters per cell, with truncation notices. Version changes require reopening. Windows/system scaling and native shortcut behavior still require actual native validation.

## Host entry

Hosts use the installed `atlas.cmd`, explicit JSON output and current capability definitions:

```text
atlas capabilities --json
atlas version --json
atlas doctor --json
```

Check `ok`, object identity and revision. UI and Host use the same state. Handoff carries explicitly selected context; it is not a copied chat archive. Different-product Host continuation remains unverified. Optional Host events/session experiments are disabled by default and their real account/Hook flows have not passed acceptance. Do not enable them as a prerequisite for the prepared sample.

## Local data and network

Project files, SQLite state and recovery snapshots stay local. The HTML server binds loopback. Explicit URL capture connects to the selected site. Installation uses the configured Python package source. External hosts decide what they send to their model services. Local Modules execute with the Atlas process account permissions and are not a sandbox. Do not install an unreviewed Module.

No cloud synchronization or automatic collection of all conversations is implemented. Recovery covers only declared, supported objects and dependencies; conflicts stop an operation. In-place text updates require supported Windows NTFS/TxF behavior and are refused when unavailable.

<a id="components"></a>
## Components and attribution

| Direct component | Pinned version | License / notice |
|---|---|---|
| markdown-it | 15.0.2 | MIT; [bundle and dependency notices](<../src/vendor/markdown-it/README.md>) |
| PDF.js | 6.4.299 | Apache-2.0; [additional resource licenses](<../assets/pdfjs/README.md>) |
| pywebview | 6.2.1 | BSD-3-Clause; installed package metadata |
| pandas | 3.0.1 | BSD-3-Clause; installed package metadata |
| pypdf | 6.14.2 | BSD-3-Clause; installed package metadata |
| pdfplumber | 0.11.10 | MIT; installed package metadata |

Adapted Rowboat mechanisms retain attribution in [link rewriting](<../src/markdown-link-rewrite.js>) and their [Apache-2.0 license](<../src/third-party/rowboat-LICENSE.txt>). This index does not replace individual dependency/resource notices. Original project code and artwork have no selected project-wide open-source license.

## Feedback

Report version/build from Settings, OS and display scale, reproduction steps, expected/observed behavior and redacted screenshots at [GitHub Issues](https://github.com/Pachin1919/keeproot/issues). Do not upload credentials, personal materials, raw conversations or a full state database. This preview has representative Windows/HTML evidence; other computers and real-project experience remain to be tested.
