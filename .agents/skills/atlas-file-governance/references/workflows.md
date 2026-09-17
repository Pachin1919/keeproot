# Atlas Current Workflows

This file is supporting reference, not the default route. Prefer `current-resource.md` or `current-save.md`.

## Project and Resource lookup

Use `atlas ui` for the installed local surface. Use `project list`, `project show`, `project resolve`, `catalog update`, or `catalog search` only when a Host needs deterministic Project or bounded filename/text facts. These commands do not authorize writing.

## Inspect or compare

Use `content inspect` for one exact file and `content compare` for two exact files. For XLSX, name one Sheet. Returned structure and counts are local deterministic facts; semantic interpretation stays with the Host.

## Save a new result

Use `save prepare`, present the exact target and conflict state, then call `save execute` only under the current user authorization. Success requires `atlas.save-result.v1`, verification, Resource identity, and recovery. Use `save undo` or `save redo`; never replace a Save failure with a different writer.

## Import and Data Work

The Desktop Import and Data Work surfaces call the same Save path. A retry must reuse its request identity and must not create a duplicate target. Source files remain unchanged. Data Work output must retain input lineage.

## Relationships

The Host may propose structured relationships. Atlas validates Resource identity and Project scope, then stores the accepted batch through `resource relationships submit`. Atlas does not infer semantic relationships itself.

## Unsupported requests

Report the missing operation. Do not route to removed Task, Task Review, Analytics, Agent Lifecycle, SessionStart Hook, or hidden Context pages. Internal Guarded, Derived, and Intake modules are implementation details and are not alternate user workflows.
