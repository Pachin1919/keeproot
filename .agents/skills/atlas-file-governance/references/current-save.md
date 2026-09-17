# Current Save Result

Use this reference when the current task authorizes saving one new result into one existing Project directory. The candidate stays outside the governed root until execution. Atlas never overwrites an existing target.

## Prepare

```powershell
& $atlasCli save prepare --root '<AUTHORIZED_ROOT>' --candidate-file '<CANDIDATE_PATH>' --project '<PROJECT_ID>' --target '<NEW_RELATIVE_PATH>' --channel <host|import|work> --request-key '<STABLE_REQUEST_KEY>' --tool '<HOST_TOOL>' --client-run-id '<CALLER_RUN_ID>' --json
```

Present the returned source, Project, target, conflict status, and recovery. Do not execute when status is not `prepared`.

## Execute and verify

```powershell
& $atlasCli save execute '<SAVE_ID>' --reason '<CURRENT_USER_TASK_AUTHORIZATION>' --json
```

Success requires `schema: atlas.save-result.v1`, `verified: true`, the expected target, and a Resource link. Report the useful result and the available recovery without dumping raw IDs or Hashes.

## Undo or redo

```powershell
& $atlasCli save undo '<SAVE_ID>' --json
& $atlasCli save redo '<SAVE_ID>' --json
```

Stop on conflict, stale state, changed target, or downstream dependency. Never substitute `intake execute`, `intake rollback`, Task, Guarded, or Derived when Save cannot proceed.
