# Spec: silent startup scan + relevance-gated collision notices + flat config

Date: 2026-09-19. Status: drafted, pending user review (do not implement before approval).
Supersedes parts of `2026-09-17-pi-workspaces-design.md` (sections 3.1, 3.2, 3.3, 4, 11); the design doc is updated in the same batch.

## Background

Today `session_start` unconditionally `notify`s every scan diagnostic (unparseable JSON, schema-invalid definitions, unknown versions) and every name collision, in every session, in every directory. A broken or stale file in `~/.pi/workspaces/` therefore pollutes sessions that have nothing to do with it (observed 2026-09-19 with stale test artifacts).

Review rulings (2026-09-19, user):

- Definition files are **assumed compliant**; the extension must not become a safety net for every possible anomaly.
- When a file cannot be parsed, **stay silent**. A user who notices their workspace did not load will investigate (via `/workspace list`, which re-scans and reports).
- When parsing succeeds but the cwd belongs to no workspace, **no warning may be emitted** - there should be no warning there in the first place.
- The only notifications that earn their place are ones with **provable relevance to the current session** (the cwd provably touches them, or the user explicitly asked).
- Separately, the config model is simplified: definitions lose their per-workspace `options` object; the plugin config is one flat struct, overridable per project.

Relevance analysis: for an *unparseable* file the intended roots are unknowable, so "does this cwd belong to it" is undecidable - any startup surfacing would have to broadcast, which is exactly the noise being removed. For *name collisions*, however, both files parsed and both root sets are known, so relevance **is** decidable; collision notices are kept but bound to provable cwd relevance.

## Decisions

- **D1 (startup silence)**: scan diagnostics are silently skipped at `session_start`. No `notify` for unparseable JSON, schema-invalid definitions, unknown versions, or unknown keys. The diagnostics strings still exist and surface through `/workspace list`'s re-scan (the explicit inspection path). Journal-restore misses remain silent (unchanged current behavior).
- **D2 (collision relevance matrix)**: a name collision no longer triggers a startup broadcast. `loadAll` additionally returns the **shadowed** (losing) definitions. Global scope only (project scope scans a single source; the matrix is vacuous there).
  - **Case A** - an activation whose workspace name also exists in the other source (auto-load, journal restore, prompt selection, `/workspace load`): after the regular activation notice, append one info line:
    `Workspace 'X' is also defined in the global source; the project definition wins.`
  - **Case B** - the cwd sits inside a root of a *shadowed* definition (and inside no root of the winning one): no activation; one warning at `session_start`:
    `Directory matches the global definition of 'X', but the project source overrides it (different roots); not loaded.`
  - **Case C** - the cwd sits inside roots of both sides: Case A behavior (activate + info line).
  - Each site fires once per activation event (Case A) or once per `session_start` (Case B). Sessions with no provable overlap see zero collision messages.
- **D3 (definition schema slimmed)**: a definition is `{ name, version, roots }` only. The `options` object is removed; a file still carrying it fails the existing unknown-key rejection (message names the key) and is silently skipped at scan (D1). Breaking change; existing user files carry no `options`, so migration is a no-op here - hand-remove the key if a file has one.
- **D4 (flat plugin config)**: one struct, `WorkspaceConfig = { activation: "auto" | "prompt"; warnOnUnrelatedLoad: boolean; projectRootAscend: number }`, resolved per key over `builtin < global < project`:
  - global file: `~/.pi/agent/pi-workspaces.json` (no `defaults` wrapper anymore)
  - project file: `<projectRoot>/.pi/pi-workspaces.json` (new)
  - a key missing at a level - or present with a wrong-typed value - silently falls through to the next level; unknown keys are ignored. Partial config files are normal form, not anomalies.
  - `projectRootAscend` is **global-only** (chicken-and-egg: it controls project discovery itself; a project must not widen its own search). It stays in the struct for uniformity; project-level values are ignored.
  - Built-in defaults unchanged: `activation: "auto"`, `warnOnUnrelatedLoad: true`, `projectRootAscend: 3`.
- **D5 (recorded tradeoff)**: `activation` is no longer per-workspace. Whether a directory prompts is a property of the project (or the global default), not of an individual root set. Install-scope gating is unchanged: project-scoped installs read only the project config and use the built-in `projectRootAscend` (section 3.1).

## Design deltas per module

### workspace-store.ts

- `WorkspaceDefinition` drops `options`; the `WorkspaceOptions` type is deleted.
- New flat `WorkspaceConfig` type (D4). `BUILTIN_DEFAULTS` gains `projectRootAscend: 3`.
- `loadGlobalConfig(): Partial<WorkspaceConfig>` - same tolerant per-key reader, flat shape (no `defaults` wrapper).
- New `loadProjectConfig(projectDir): Partial<WorkspaceConfig>` reading `<projectRoot>/.pi/pi-workspaces.json`; missing file yields `{}`. Same tolerance rules.
- New `resolveConfig(project, global): WorkspaceConfig` - per-key `project ?? global ?? builtin`. Replaces `resolveOptions` (deleted).
- `loadAll` returns `{ merged, shadowed, warnings, collisions }` where `shadowed` holds the losing definitions in the same `{ def, origin }` shape as `merged`. Pure-function change; warnings/collisions semantics unchanged.
- `projectConfigFile(projectDir)` helper for the new path.

### index.ts

- `session_start`: the two unconditional notify loops (warnings, collisions) are removed.
- Config resolved once: global scope = `resolveConfig(loadProjectConfig(discovered), loadGlobalConfig())`; project scope = `resolveConfig(loadProjectConfig(discovered), {})` with built-in `projectRootAscend` (global config unread in project scope).
- Containing check unchanged (against `merged`). New: containment check against `shadowed` for Case B (global scope only).
- Case A info line appended at each activation site: auto-load, journal restore, prompt selection.
- Auto-load / prompt / multi-match / journal-restore flows otherwise unchanged (section 4 steps 3-6).

### commands.ts

- `load` (loadWorkspace): the `warnOnUnrelatedLoad` guard now reads `resolveConfig(...)` instead of the per-workspace options chain; after a successful activation whose name is in `collisions`, append the Case A info line.
- `list` unchanged: still re-scans and notifies diagnostics (the explicit inspection path D1 points at); collision annotations in the listing are explicitly out of scope.
- `create` / `save` / `changeRoots` write option-less definitions (schema change flows through automatically).

### Docs

- Design doc: section 3.1 table (definitions content, config row gains the project-level file), section 3.2 rewrite (slim schema, flat config, two-level chain), section 3.3 collision bullet replaced by the relevance matrix, section 4 (no startup diagnostics; shadowed check; notice wording), section 11 first two rows (silent at session_start; surface via `/workspace list`), new decision-record section.
- README.md + README_zh.md: schema example without `options`, flat config example, two-level resolution, notification-behavior notes.

## Acceptance criteria

- `node --test "test/**/*.ts"` green, including new tests:
  - startup emits no warning-level notifications when a definition file is broken (regression flip of the current assertions);
  - collision matrix: Case A info on auto-load / restore / selection / `load`; Case B warning and no activation when the cwd only matches a shadowed root; Case C; zero messages without cwd overlap;
  - `options` key rejected with the key named;
  - flat config: per-key fallback (project > global > builtin), wrong-typed value falls through, unknown keys ignored, missing files yield builtins, `projectRootAscend` ignored from the project file.
- `npx tsc --noEmit` clean.
- Headless RPC dry runs: broken file present + unrelated cwd = zero notifications; collision cases per matrix; project config override of `warnOnUnrelatedLoad` respected by `/workspace load`.
- Manual TUI checklist re-run (statusline, select, `/resume`, `/workspace list` diagnostics).
