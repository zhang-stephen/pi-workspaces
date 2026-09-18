# pi-workspaces — Multi-Root Workspace Extension for pi

**Status**: Approved design, awaiting implementation plan
**Date**: 2026-09-17
**Scope**: pi coding agent extension (TypeScript, no build step)

---

## 1. Overview

pi anchors every session to a single working directory (`ctx.cwd`). This extension overlays a **multi-root workspace** (VS Code-style) on top of a session: several directories ("roots") are merged into one named workspace, and the agent can transparently read, write, search, and execute across all of them.

One root is designated **primary**. The primary root's agent-constraint files (AGENTS.md / CLAUDE.md) act as the fallback for roots that have no constraints of their own.

### Goals

- Cross-root file operations (read/write/edit/grep/find/ls) via a uniform path syntax
- Cross-root shell execution via an explicit `cwd` parameter on the `bash` tool
- Workspace definitions persisted as JSON, shareable via git (project-level) or kept personal (global)
- Discoverability: system-prompt injection, editor autocomplete, footer statusline
- Zero behavior change when no workspace is active

### Non-goals (MVP)

- No extra permission guardrails outside registered roots (pi defaults apply)
- No cross-root aggregated search convenience commands
- No interactive create wizard, no `set-primary` command (post-MVP)
- No fs.watch hot-reload of definitions
- No project-level override of global default config

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **workspace** | A named set of roots plus options, stored as one JSON file |
| **root** | A member directory of a workspace, identified by a unique root name |
| **primary root** | The root whose constraint files serve as the fallback for other roots |
| **active workspace** | The workspace currently loaded into the session (at most one) |
| **global source** | `~/.pi/agent/workspaces/*.json` |
| **project source** | `<repo>/.pi/workspaces/*.json` |

Root names must be valid identifiers: letters, digits, `-`, `_`; no path separators. Uniqueness is enforced per workspace at load time; duplicate or illegal names reject the whole workspace definition with an error message.

Root name assignment (in priority order): explicit `name` in the definition file > directory basename > (on conflict) load-time validation error asking for an explicit name.

---

## 3. Data Model & Storage

### 3.1 Three storage layers

| Layer | Content | Location | Written by |
|-------|---------|----------|------------|
| Workspace definitions | roots, per-workspace options | `~/.pi/agent/workspaces/<name>.json` **and** `<project>/.pi/workspaces/<name>.json` (project dir discovered by marker ascent, §3.3) | `/workspace create`, `/workspace add-root`, etc. |
| Global default config | default option values | `~/.pi/agent/pi-workspaces.json` | `/workspace config` (post-MVP); hand-editable |
| Session state | name of the active workspace | `pi.appendEntry()` in the session file | automatic on load/unload |

pi has no unified extension settings API; its `settings.json` schema is owned by pi core with no extension namespace. Following the official `preset.ts` example, the extension manages its own JSON files, locating the global directory via `getAgentDir()`.

**Install scope gates access to these layers.** The extension detects its own file location: a global install under `<agentDir>/extensions/` may use all three layers; anything else - a project install under `<cwd>/.pi/extensions/` or an explicit `-e` dev path - is project-scoped and touches only the discovered project source plus the session journal. The global definition directory and the global default config are neither read nor written in project scope. Rationale: a repo-shared extension must not peek at (or mutate) the user's personal workspaces.

### 3.2 Workspace definition schema

```json
{
  "name": "my-workspace",
  "version": 1,
  "roots": [
    { "name": "backend",  "path": "C:/repos/backend" },
    { "name": "frontend", "path": "C:/repos/frontend" }
  ],
  "options": {
    "activation": "auto",
    "warnOnUnrelatedLoad": true
  }
}
```

- `version`: schema version, currently `1`; unknown versions are skipped with a warning
- `roots`: an **unordered set of equal roots** - there is no primary root (removed 2026-09-19, see §17)
- `options`: per-workspace overrides of the global defaults
  - `activation`: `"auto"` (load silently when the session cwd is inside any root) or `"prompt"` (ask first)
  - `warnOnUnrelatedLoad`: warn when `/workspace load` activates a workspace whose roots do not contain the cwd

Global default config (`~/.pi/agent/pi-workspaces.json`):

```json
{
  "defaults": {
    "activation": "auto",
    "warnOnUnrelatedLoad": true
  },
  "projectRootAscend": 3
}
```

Option resolution chain (per option):

```
workspace.options.<key> ?? globalDefaults.defaults.<key> ?? builtInDefault
```

Built-in defaults: `activation: "auto"`, `warnOnUnrelatedLoad: true`, `projectRootAscend: 3`.
`projectRootAscend` is a **global-only** knob (chicken-and-egg: it controls how definitions are
found), so it never participates in the per-workspace chain and is ignored in project scope.

### 3.3 Dual-source loading (merge rule)

The **project source** is discovered by marker ascent (2026-09-19, §17): walk up from the session
cwd at most `projectRootAscend` levels and stop at the first directory containing any root marker
(`.pi`, `.git`, `.agents`). The nearest marker directory wins even when it has no `.pi/workspaces`
subdirectory - the project source is then simply empty (no error, no further ascent into outer
projects). Discovery never ascends above the user's home directory; with no marker inside the cap,
the project dir is the cwd itself.

At `session_start` a global-scope install scans **both** sources and merges **by name, project source wins** — the official pi convention (core skills/agents/themes and the `preset.ts` example all override per name, never wholesale). Full override is explicitly rejected: a project definition must not hide the user's unrelated global workspaces. Project-scope installs scan only the project source, so no merging applies to them.

- Each merged definition records `origin: "global" | "project"`, shown in `/workspace list`
- A name collision triggers a `notify` ("workspace 'X' from project overrides global") once per session

### 3.4 Write semantics

- **Atomic writes**: write `<file>.tmp`, then `rename`; readers must tolerate and skip corrupt files with a warning
- Directories are created on demand (`mkdir -p`)
- Read timing: full scan at `session_start`; commands update in-memory state and persist immediately; no fs.watch (MVP)

---

## 4. Activation

On `session_start`:

1. Scan the visible sources (§3.3)
2. Compute the **containing set**: definitions where `ctx.cwd` sits inside any root
3. Exactly one containing workspace with `activation: "auto"` → auto-load it silently. Multiple containing workspaces always prompt (disambiguation), even when all say `"auto"`
4. Otherwise, when the containing set is non-empty and `ctx.hasUI` → `ctx.ui.select` offering exactly the containing workspaces plus "Don't load" (covers `activation: "prompt"` and multi-match). A session started outside every workspace root is never prompted - loading from an unrelated directory is always an explicit `/workspace load`
5. The active workspace name is persisted via `pi.appendEntry()` so `/resume` restores it; the write is skipped when the last journaled entry already records the same state (reload-safe, 16.5)
6. `/workspace load <name>` manually activates a workspace at any time; `/workspace unload` deactivates. Loading a workspace whose roots do not contain the cwd warns (bare relative paths stay anchored at the session directory) but proceeds, gated by `warnOnUnrelatedLoad`

**Project-level installation caveat**: if the extension is installed under `<repo>/.pi/extensions/`, pi only discovers it when the session starts inside that repo, and the install is project-scoped (§3.1) - global definitions stay invisible. This is expected and documented in the README, not an error.

Only one workspace may be active at a time. Loading another replaces the current one (with a notify).

---

## 5. Path Resolution

Core algorithm used by all overridden tools. Priority order:

1. **Absolute path** → normalize (`realpath` when it exists); attribute to the longest-prefix matching root; if no root contains it, pass through unchanged (pi default behavior)
2. **`@root-name/relative/path`** → resolve against that root's absolute path; the result must stay inside the root (`..` escapes are rejected with an error)
3. **Bare relative path** → resolve against `ctx.cwd` (session start directory) — identical to pi's default semantics, never changed

Failure modes return tool errors the model can self-correct from:

- Unknown root name → error listing the available root names
- Escape attempt (`@backend/../../etc`) → error stating the constraint
- Root path missing on disk → error marking the root as unavailable (see §11)

Symlinks: containment checks use `realpath` on both the root and the resolved path so symlinked roots and symlinked targets behave consistently.

Windows: comparisons are case-insensitive on drive letters and normalize `/` vs `\`.

---

## 6. Tool Overrides

All seven built-in tools are overridden by registering same-name tools. Overrides are thin: translate paths, then delegate to a factory-created instance bound to the resolved directory.

### 6.1 Shared rules

- Keep each tool's result-shape contract (`content` + tool-specific `details`) so built-in renderers keep working
- **Do not define** `renderCall`/`renderResult` → built-in rendering is inherited automatically
- **Explicitly define** `promptSnippet` and `promptGuidelines` (NOT inherited on override); append the `@root/` syntax and bash `cwd` usage
- Write serialization is provided by the built-in tools' internal `withFileMutationQueue`; do NOT wrap it at the override layer (same key, non-reentrant -> deadlock, verified in dist and reproduced empirically)
- Resolution failures THROW `Error`: the pi harness converts throws into error results with the same content shape and flags them in the transcript, whereas a returned `isError` flag is silently dropped by agent-core (verified in `executeToolCall`)
- When no workspace is active, every override delegates verbatim to the built-in with zero behavior change

### 6.2 File tools: read / write / edit / grep / find / ls

- Schemas mirror the built-ins; the `path` parameter additionally accepts the `@root-name/` prefix
- `execute`: resolve the path per §5, then delegate to `createXxxTool(resolvedRootDir)` with the resolved relative/absolute path
- `grep`/`find`/`ls` scoped to a root when addressed via `@root/`; absolute paths outside all roots pass through

### 6.3 bash

Note: the correct factory base for overrides is `createBashToolDefinition` (registerTool consumes ToolDefinition; rendering is inherited via the built-in renderer registry when render functions are omitted). Same applies to the file tools: `createReadToolDefinition` etc.

```typescript
pi.registerTool({
  name: "bash",
  label: "bash",
  description: "<built-in description> + @root cwd syntax",
  parameters: Type.Object({
    command: Type.String({ description: "..." }),
    timeout: Type.Optional(Type.Number({ description: "..." })),
    cwd: Type.Optional(Type.String({
      description: "Working directory: '@root-name/sub/path' or absolute path. Defaults to the session start directory.",
    })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const resolved = resolveWorkspaceDir(params.cwd, workspace, ctx.cwd);
    return createBashTool(resolved).execute(id, params, signal, onUpdate, ctx);
  },
});
```

- `cwd` appears in the tool schema, so the model discovers and uses it proactively — this is the key advantage over asking the model to prefix `cd`
- pi's bash spawns a fresh process per call (stateless), so per-call cwd is safe
- `cwd` accepts the same three forms as §5; omission means `ctx.cwd`

---

## 7. System Prompt Injection

`before_agent_start` (and after every load/unload) appends a workspace section to the system prompt when a workspace is active:

1. **Workspace map**: root name → absolute path, missing roots marked
2. **Syntax rules**: `@root-name/path` prefix; bare relative paths = session start directory; absolute paths work everywhere
3. **bash usage**: the `cwd` parameter
4. **Constraint policy**: each root's own AGENTS.md/CLAUDE.md governs work inside it; roots without one fall back to the constraints of the **session root** (the root containing the session cwd); when the cwd is inside no root there is no fallback

### On-demand constraint injection

Constraint files of the root containing the session cwd are loaded natively by pi (session start directory). For other roots: the **first time** a tool call touches a root during the session, that root's constraint files (if any) are appended to the tool result, preceded by a marker line; a root without constraint files falls back to the session root's files, and otherwise yields a one-line "no root-specific constraints" note. Injection happens once per root per session — tracked in memory, reset on load/unload. When the touched file IS the constraint file about to be injected, the injection is skipped (16.4) - the tool result already delivered the content.

This avoids front-loading every root's constraints into the system prompt.

---

## 8. Commands

| Command | Behavior |
|---------|----------|
| `/workspace` | Show active workspace status (roots, health, origin) |
| `/workspace list` | List all definitions from both sources, with `origin` |
| `/workspace load <name>` | Activate a workspace; warns when its roots do not contain the cwd (`warnOnUnrelatedLoad`) |
| `/workspace unload` | Deactivate; statusline clears |
| `/workspace create <name>` | Create a definition with the cwd as its sole root (in the source matching the install scope) |
| `/workspace add-root [name] <path>` | Add a root to the active workspace (alias: `add`) |
| `/workspace remove-root <name>` | Remove a root; the last remaining root is protected (alias: `remove`) |

All commands available in RPC mode; interactive pickers fall back to argument-based usage when `ctx.hasUI` is false.

Post-MVP: `/workspace config` (edit global defaults), create wizard, `/workspace reload`.

---

## 9. Editor Autocomplete

A provider registered via `ctx.ui.addAutocompleteProvider()` stacked on top of pi's built-in completion:

- Typing `@` offers root-name completions (`@backend`, `@frontend`, ...)
- After `@root-name/`, completes file/directory paths inside that root, matching built-in path-completion UX
- Anything not matching the `@root` pattern delegates to the built-in provider unchanged
- `applyCompletion` delegates to the built-in provider

Performance guards: cap result count, skip `node_modules`/`.git`, respect `.gitignore` (reuse pi's walker utilities if exported).

Note: this only affects paths the **user** types into the prompt editor. The model generates tool-call paths directly and needs no completion.

---

## 10. Statusline

Footer status via `ctx.ui.setStatus("pi-workspaces", text)` — keyed, stackable, persistent, theme-aware. `setFooter` (replaces built-in footer) and `setWidget` (occupies a full line) were rejected as too invasive.

States:

```
inactive:        (status cleared — no noise)
active, healthy: [ws] my-workspace (3 roots)
active, degraded:[ws] my-workspace (2/3 roots)  ! frontend missing
```

Colors via `ctx.ui.theme`: `accent` for icon + name, `dim` for metadata, `warning` for degradation.

Refresh triggers: `session_start` auto-load, `load`/`unload`, `add-root`/`remove-root`, root health changes. Health data comes from the store's load-time check (§11) — single source of truth. No-op in RPC/print mode automatically.

---

## 11. Error Handling

| Condition | Behavior |
|-----------|----------|
| Corrupt definition JSON | `notify` warning at scan; file skipped; others load normally |
| Unknown schema version | Skip with warning |
| Root path missing on disk | Workspace loads; root flagged unhealthy; statusline shows degraded; tool calls into it return a clear error |
| Duplicate/illegal root name | Definition rejected with an explanatory error |
| Unknown `@root` in a tool call | Tool error listing available root names |
| `..` escape attempt | Tool error stating the containment rule |
| Write outside all roots | Allowed — pi default behavior, no guardrails (explicit product decision) |

---

## 12. Testing

- **Unit tests** (`node:test`): `path-resolver` (all §5 cases incl. escapes, Windows separators, symlink fixtures) and `workspace-store` (schema validation, dual-source merge, option resolution chain, atomic write, corrupt-file tolerance) — all pure or temp-dir based, no pi runtime needed
- **Integration tests**: temp directories forming two/three-root workspaces; drive the overridden tools' `execute` against them; verify delegation results and error shapes
- **Manual acceptance**: `pi -e ./index.ts` in a real session — cross-root edit + bash + grep; statusline; `/workspace` commands; `/resume` restores active workspace

---

## 13. MVP Scope

**In**: §3 storage (dual-source, merge rule), §4 activation, §5 resolution, §6 all seven tool overrides, §7 injection, §8 commands (table only), §9 autocomplete, §10 statusline, §11 error handling, §12 tests.

**Out** (post-MVP): `/workspace config`, create wizard, `/workspace reload`, fs.watch, cross-root search conveniences, project-level override of global defaults.

---

## 14. Installation & Distribution

| Install location | Loads when session starts in... | Use case |
|------------------|--------------------------------|----------|
| `~/.pi/agent/extensions/pi-workspaces/index.ts` | any directory (global) | personal, cross-project |
| `<primary-repo>/.pi/extensions/pi-workspaces/index.ts` | that repo only (after trust) | bound to a primary repo; team sharing |
| `settings.json` `packages` (npm/git) or `extensions` (paths) | per pi's settings rules | packaged distribution |

- Project-level install means the extension is absent in other roots' sessions (§4 caveat) — documented in README
- **Never install in both locations at once**: pi loads both instances and tool overrides double-register — README carries an explicit warning
- README includes: feature tour, both install methods, workspace JSON schema, `@root/` syntax, command reference, FAQ (merge rule, project-install caveat, double-install warning)

---

## 15. Module Structure

```
index.ts                 # ExtensionFactory: wiring only (register tools/commands/providers, hook events)
src/workspace-store.ts   # Definition & config IO: scan, validate, merge, atomic write, health check
src/path-resolver.ts     # Pure path resolution per §5 (no IO)
src/tools.ts             # Seven tool overrides per §6
src/commands.ts          # /workspace command implementations per §8
src/prompt-inject.ts     # System prompt section + on-demand constraint injection per §7
src/statusline.ts        # Status rendering & refresh per §10
src/autocomplete.ts      # Completion provider per §9
test/                    # node:test suites per §12
```

Dependency direction: `index.ts` → modules → (`workspace-store`, `path-resolver`). Modules never import each other cyclically; `tools`/`commands`/`prompt-inject`/`statusline` depend on store + resolver only.

---

## 16. Recorded Ideas & Known Issues (2026-09-18)

User feedback and dry-run discoveries, recorded for future iterations.

### 16.1 Autocomplete vision (partially implemented)

Current state (§9): typing `@` with an active workspace shows **only** root names (the built-in file completion is suppressed for `@` tokens); after `@root/` only that root's entries appear. The user's target design:

1. When a workspace is active, typing `@` should show the other roots **pinned above the current directory's file completions** (merged list, not root-names-only), each root annotated with a description like `[root]: <abs path>`.
2. After a root is selected, the suggestion list refreshes to show only candidates under that root. (Already the current stage-2 behavior.)

### 16.2 Command palette source attribution

RESOLVED (2026-09-19): verified against pi's dist - for directory installs the palette tag only
prefixes a scope letter ([u]/[p]/[t]); the extension name is rendered only for npm/git package
sources ([u:npm:...]). The /workspace description therefore carries the attribution itself
("pi-workspaces: manage ...").

### 16.3 Command alias: add / remove

RESOLVED (2026-09-19): `add` / `remove` are first-class aliases of `add-root` / `remove-root`;
the long forms keep working.

### 16.4 Known issue: constraint self-injection duplicates content

Reproduced in session `01a0b551-0e4a-727a-b466-44c4a7dedf6f`: `read @yolo/AGENTS.md` returned the file's content twice — once as the first-touch constraint block (which *is* that file's content), once as the file body. The model flagged the duplication itself. RESOLVED (2026-09-19): when the resolved target file is the very constraint file about to be injected, the injection is skipped.

### 16.5 Known issue: journal entries duplicate on repeated session_start

Same session: five consecutive `pi-workspaces:active` entries with identical data, caused by `session_start` re-firing (extension reloads while testing) and each firing appending unconditionally. RESOLVED (2026-09-19): `setActive` skips `appendEntry` when the last journaled name already equals the new one.

---

## 17. Decision Record: No-Primary Refactor (2026-09-19)

Full spec: `2026-09-19-no-primary-refactor-design.md` (same directory). Sections 3.2, 3.3, 4, 7,
8 and 10 of this document are already synced; the decisions in brief:

- **D3**: `primary` removed entirely - a workspace is an unordered set of equal roots.
- **D4**: `activation: "auto" | "prompt"` replaces `autoLoadInPrimary`/`promptInOtherDirs`;
  built-in default `"auto"`. Multiple containing workspaces always prompt.
- **D5**: project source discovered by marker ascent (`.pi`/`.git`/`.agents`, nearest wins, capped
  by global-only `projectRootAscend` = 3, never above home); a marker dir without `.pi/workspaces`
  means an empty project source, not further ascent.
- **D6**: constraint fallback chain = touched root -> session root (root containing the cwd) ->
  none; unrelated loads have no fallback.
- **D7**: `/workspace load` of a non-containing workspace warns (`warnOnUnrelatedLoad`, default
  true) but proceeds.
- **D8**: `remove-root` protects the last remaining root (replaces primary protection).
- **D9** (simplified during implementation): no dedicated legacy-key detection. The `primary`
  field is simply not part of the schema anymore; legacy option keys fail the generic
  unknown-option validation; existing definition files are migrated by hand.
- **D10**: same batch fixed 16.2 (source attribution verified), 16.3 (add/remove aliases), 16.4
  (constraint self-injection skip), 16.5 (journal dedupe). 16.1 (autocomplete vision) is deferred.
