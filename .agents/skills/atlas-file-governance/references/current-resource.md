# Current Resource Inspection

Use this reference only for one or two explicitly authorized local files.

## Inspect one file

```powershell
& $atlasCli content inspect --file '<EXACT_PATH>' --purpose <structure|content|data|visual> --json
```

For XLSX data inspection, also pass `--sheet '<EXACT_SHEET>'`. Use returned deterministic facts; do not ask the model to recount rows or infer missing structure.

## Compare two files

```powershell
& $atlasCli content compare --left '<EXACT_PATH>' --right '<EXACT_PATH>' --json
```

Inspection does not authorize saving, moving, overwriting, or deleting either file. If the current Runtime reports an unsupported format or boundary, stop and report that result; do not fall back to a legacy Task workflow.
