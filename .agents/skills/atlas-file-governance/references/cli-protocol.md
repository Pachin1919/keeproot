# Atlas CLI Protocol

Use this reference only for an unfamiliar JSON response or Runtime error.

Run the installed launcher returned by `scripts/locate-atlas.ps1`. Add `--json`, require `protocol_version: atlas-cli.v1`, require boolean `ok`, and preserve the full error envelope when reporting an unexpected failure. Never run Runtime source files directly because that can bypass installed-state binding.

## Current product namespaces

- `ui`: local Desktop surface and its install/doctor/remove lifecycle.
- `save`: prepare, show, execute, undo, and redo one new result.
- `content`: deterministic inspection or comparison of exact authorized files.
- `resource relationships submit`: persist Host-proposed relationships after Atlas validates identities and Project boundaries.

`capabilities --json` is authoritative. A missing namespace is unsupported; do not reconstruct it through an internal service.

## Error handling

- `ATLAS_PATH_BOUNDARY`: the path escaped an authorized Root or crossed a link/junction. Correct the path or stop.
- `ATLAS_NOT_FOUND`: verify the exact Resource, Save ID, Project, or path once.
- `ATLAS_INVALID_ARGUMENT`: compare the call with current capabilities and syntax.
- `ATLAS_STATE_CONFLICT`: stop writes and report the changed state.
- `ATLAS_ROLLBACK_CONFLICT`: preserve the later file state; never overwrite it manually.
- `ATLAS_COMMAND_FAILED`: inspect the message and current state before deciding anything.

Exit `0` means the command returned successfully; still check its status and verification fields. Exit `1` is a failed command or health check. Exit `2` records a tracked scope/risk violation. Exit `3` is a recovery conflict.

Caller fields (`--actor`, `--agent`, `--model`, `--tool`, `--client-run-id`) are audit metadata, not authentication. Reuse the caller run ID for related calls and preserve Atlas-generated operation IDs.

Historical SQLite tables may exist after upgrades. They have no product or Skill command route and must not be interpreted as pending user work.
