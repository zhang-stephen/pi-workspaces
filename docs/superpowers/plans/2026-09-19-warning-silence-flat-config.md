# Plan: silent startup scan + collision matrix + flat config

Spec: `docs/superpowers/specs/2026-09-19-warning-silence-flat-config-design.md` (read first; pending user review - do not start until approved).
Execution: two sequential commits, each with code + tests + doc sync. Repo gate before every commit: `node --test "test/**/*.ts"`.

## Commit 1 - `feat(src): silent startup scan, relevance-gated collision notices`

### T1. workspace-store: keep shadowed definitions

- `loadAll` returns `{ merged, shadowed, warnings, collisions }`; `shadowed: MergedEntry[]` holds the losing side of each name collision (same `{ def, origin }` shape as `merged`).
- Pure function; no IO change.
- Tests (store-io): one collision -> merged keeps the project entry, shadowed holds the global entry with `origin: "global"`; no collision -> shadowed empty; project scope -> both empty.

### T2. index.ts: startup silence + collision matrix

- Delete the two unconditional notify loops (warnings, collisions) in `session_start`.
- After the containing check on `merged`, run the shadowed containment check (global scope only): cwd inside a shadowed root and inside no merged root -> one warning, `Directory matches the global definition of 'X', but the project source overrides it (different roots); not loaded.` (Case B), then fall through to the "nothing active" path.
- Case A info line (`Workspace 'X' is also defined in the global source; the project definition wins.`) appended after the activation notice at: single-match auto-load, journal restore, prompt selection.
- Journal-miss path: still silent (D1).
- Tests (wiring):
  - flip current assertions: broken.json present -> zero warning-level notifications at startup (auto-load case included);
  - collision present, no cwd overlap -> zero collision notifications;
  - Case A: auto-load + collision -> auto-loaded notice followed by the info line;
  - Case B: cwd only inside the shadowed global roots -> warning + no activation + empty statusline;
  - Case C: cwd inside both -> activation + info, no warning;
  - journal restore of a collided name -> info line;
  - prompt selection of a collided name -> info line.

### T3. commands.ts: Case A on explicit load

- `load`: after successful activation, when the name is in `collisions`, append the Case A info line. `warnOnUnrelatedLoad` guard untouched in this commit.
- Tests (commands): load of a collided workspace -> info line; load of a clean workspace -> none.

### T4. Doc sync for commit 1

- Design doc: section 3.3 collision bullet -> pointer to the relevance matrix; section 4 steps (no startup diagnostics, shadowed check, notice wording); section 11 first two rows -> "silently skipped at session_start; surfaces via /workspace list re-scan".
- README.md + README_zh.md: notification-behavior notes.

## Commit 2 - `feat(src): flat plugin config, drop per-workspace options`

### T5. workspace-store: slim schema + WorkspaceConfig

- `WorkspaceDefinition` = `{ name, version, roots }`; `options` now hits the existing unknown-option rejection (message names the key). Delete `WorkspaceOptions`.
- New `WorkspaceConfig = { activation; warnOnUnrelatedLoad; projectRootAscend }`; `BUILTIN_DEFAULTS` gains `projectRootAscend: 3`.
- `loadGlobalConfig(): Partial<WorkspaceConfig>` - flat read, no `defaults` wrapper, same per-key tolerance (wrong type / unknown key -> skipped).
- New `loadProjectConfig(projectDir)` + `projectConfigFile(projectDir)` -> `<projectRoot>/.pi/pi-workspaces.json`; missing file -> `{}`.
- New `resolveConfig(project, global)` - per-key `project ?? global ?? builtin`; delete `resolveOptions`.
- Tests (store-io): `options`-key rejection; flat global parse (valid, wrong-typed per key, unknown key, missing file); project config parse + missing-file case; `resolveConfig` fallback matrix; project-level `projectRootAscend` is read but never applied by callers (asserted via index tests below).

### T6. index.ts + commands.ts: consume resolveConfig

- `session_start`: resolve config once - global scope `resolveConfig(loadProjectConfig(discovered), loadGlobalConfig())`; project scope `resolveConfig(loadProjectConfig(discovered), {})`. Auto-load decision and journal path read `config.activation`.
- `load`: unrelated-cwd guard reads `config.warnOnUnrelatedLoad`.
- Tests (wiring + commands): project config `activation: "prompt"` forces the select flow for a single match; project config `warnOnUnrelatedLoad: false` silences the load warning; global-only config still applies when the project file is absent.

### T7. Doc sync for commit 2

- Design doc: section 3.1 table rows (definitions "roots" only; config row gains the project-level file), section 3.2 rewrite (slim schema example, flat config example, two-level chain, `projectRootAscend` global-only note), new decision-record section (D1-D5 of the spec).
- README.md + README_zh.md: schema example without `options`, flat config example, resolution chain.

## Final verification (after commit 2)

- `node --test "test/**/*.ts"` + `npx tsc --noEmit`.
- Headless RPC dry runs: broken file + unrelated cwd = zero notifications; Case A/B/C matrix; project config overrides (`activation`, `warnOnUnrelatedLoad`); project-scoped install reads no global config.
- Manual TUI checklist: statusline, select flow, `/resume`, `/workspace list` diagnostics output.

## Out of scope (recorded)

- Collision annotations inside `/workspace list` output.
- A `/workspace config` command (design doc lists it post-MVP).
- Any editor-schema / authoring-time validation machinery.
- Cleanup of the stale `ghost.json` / `smoke.json` in the real global directory (user-hand deletion; unrelated to code).
