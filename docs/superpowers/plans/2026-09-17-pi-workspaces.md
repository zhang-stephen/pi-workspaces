# pi-workspaces Implementation Plan (contract-first)

> **For agentic workers:** REQUIRED SUB-SKILL: use subagent-driven-development (preferred) or executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax to track progress.

**Goal:** Build a pi coding agent extension that merges multiple directories ("roots") into one multi-root workspace with transparent cross-root file tools, bash cwd routing, prompt injection, autocomplete, and a footer statusline.

**Architecture:** One extension entry (`index.ts`, wiring only) plus focused modules under `src/`. All seven built-in tools are overridden with thin wrappers that resolve `@root-name/path` prefixes via a pure resolver, then delegate to pi's `createXxxTool(cwd)` factories. Workspace definitions are JSON files merged from a global source and a project source (per-name, project wins).

**Tech stack:** TypeScript (no build step, loaded by pi via jiti; Node >= 23 runs tests via native type stripping), `node:test`, `@earendil-works/pi-coding-agent` factories, `typebox` for schemas.

**Spec:** `docs/superpowers/specs/2026-09-17-pi-workspaces-design.md` — the binding authority; read it together with this plan.

**Plan style:** contract-first. Each task pins exported signatures, behaviors, and test acceptance points. Implementation details are up to the implementer unless stated.

## Global Constraints

- ASCII only in code and documentation files
- Conventional Commits with component scope: `feat(src):`, `test(test):`, `docs:`
- `docs/` stays uncommitted (working tree only)
- No third-party runtime dependencies; devDependencies are allowed
- Bare relative paths ALWAYS resolve against the session start directory
- Workspace definitions merge by name; project source wins; never full override
- No permission guardrails for paths outside registered roots (pi defaults apply)
- All storage writes atomic: temp file + rename
- Overridden tools: keep result-shape contract, omit render functions, define promptSnippet/promptGuidelines explicitly
- Run `node --test test/` before every commit; it must pass
- Local imports use explicit `.ts` extensions (Node type stripping requirement)

## Test Strategy (LLM-minimal)

- All automated tests are deterministic `node:test` suites against temp-dir fixtures. Zero LLM calls.
- Tool/command/wiring tests use hand-written mock `ExtensionAPI`/`ExtensionContext` stubs — no pi runtime.
- Manual acceptance is ONE scripted smoke session (Task 13), ~5 fixed prompts.

## File Structure

```
package.json / tsconfig.json     # manifest + editor DX (noEmit)
index.ts                         # ExtensionFactory: wiring only
src/path-resolver.ts             # pure path resolution (no IO)
src/workspace-store.ts           # schema, dual-source scan, merge, atomic IO, health
src/tools.ts                     # 7 built-in tool overrides
src/prompt-inject.ts             # prompt section + first-touch constraint injection
src/statusline.ts                # footer status rendering
src/commands.ts                  # /workspace commands
src/autocomplete.ts              # editor @root completion provider
test/*.test.ts + test/helpers.ts # fixtures (makeTempDir, writeFile) + mocks (mockCtx, mockPi, emit)
README.md
```

---

### Task 1: Project scaffolding

- [ ] Create `package.json` (`type: "module"`, script `"test": "node --test test/"`, devDependencies: `@earendil-works/pi-coding-agent`, `@types/node`, `typebox`, `typescript`), `tsconfig.json` (`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `strict`, `module/moduleResolution: nodenext`), and `test/helpers.ts`.
- [ ] `test/helpers.ts` exports: `makeTempDir(prefix?)`, `writeFile(root, rel, content)`, `mockCtx(cwd, extra?)` (hasUI false, ui stubs with `theme.fg = (_c, t) => t`), `mockPi()` (captures tools/commands/handlers/entries maps), `emit(handlers, event, payload, ctx)`.
- [ ] If the npm registry is unreachable, junction `node_modules/@earendil-works/pi-coding-agent` to the global install at `C:/Users/yiche/node_modules/@earendil-works/pi-coding-agent`.
- [ ] Verify: `node --test test/` exits 0. Commit: `chore: scaffold project with node:test setup`

### Task 2: path-resolver

**Exports (pinned):**

```typescript
export interface RootInfo { name: string; path: string; exists: boolean }
export interface WorkspaceInfo { name: string; roots: RootInfo[]; primary: string; origin: "global" | "project" }
export type ResolveResult =
  | { ok: true; absolutePath: string; root: RootInfo | null }
  | { ok: false; error: string }
export function isInside(parent: string, child: string): boolean
export function owningRoot(ws: WorkspaceInfo, absolutePath: string): RootInfo | null
export function resolveWorkspacePath(input: string, ws: WorkspaceInfo | null, sessionCwd: string): ResolveResult
```

**Behaviors:** priority absolute > `@root-name/...` > bare-relative-to-sessionCwd; unknown root error lists all root names; missing root errors as unavailable; `..` escape rejected; `@root` with no active workspace errors; absolute paths attributed by longest-prefix (nested roots); win32 drive-letter case-insensitive comparison; containment is lexical (root paths are canonicalized by the store). `@root` with empty path part resolves to the root dir itself.

**Tests (`test/path-resolver.test.ts`):** one case per behavior above (12 cases): relative->cwd, @root hit, unknown root (error lists names), missing root, escape rejected, no-workspace error, absolute attribution, outside-all-roots pass-through (root null), nested longest-prefix, isInside edge cases (same dir, child, sibling), win32 case.

Commit: `feat(src): add workspace path resolver`

### Task 3: workspace-store — validation, merge, options

**Exports (pinned):**

```typescript
export interface RootDefinition { name: string; path: string }
export interface WorkspaceOptions { autoLoadInPrimary: boolean; promptInOtherDirs: boolean }
export interface WorkspaceDefinition { name: string; version: 1; roots: RootDefinition[]; primary: string; options?: Partial<WorkspaceOptions> }
export interface LoadedDef { def: WorkspaceDefinition; origin: "global" | "project" }
export const BUILTIN_DEFAULTS: WorkspaceOptions  // { autoLoadInPrimary: true, promptInOtherDirs: true }
export function validateDefinition(data: unknown): { ok: true; def: WorkspaceDefinition } | { ok: false; error: string }
export function mergeByName(globalDefs: WorkspaceDefinition[], projectDefs: WorkspaceDefinition[]): { merged: LoadedDef[]; collisions: string[] }
export function resolveOptions(def: WorkspaceDefinition, defaults: WorkspaceOptions): WorkspaceOptions
```

**Behaviors:** reject unknown version, illegal workspace/root names (`/^[A-Za-z0-9_-]+$/`), duplicate root names, empty roots, primary not in roots; merge per-name with project winning and collisions reported; options chain workspace ?? defaults ?? builtin.

**Tests (7):** valid passes; each rejection case (4); merge project-wins + global-only names survive + collisions; options chain (3 levels).

Commit: `feat(src): add workspace definition validation and merge`

### Task 4: workspace-store — scan, IO, health, root ops

**Exports (pinned, appended):**

```typescript
export function globalWorkspacesDir(): string            // getAgentDir() + /workspaces
export function projectWorkspacesDir(cwd: string): string // <cwd>/.pi/workspaces
export function scanSource(dir: string, origin: "global" | "project"): { defs: WorkspaceDefinition[]; warnings: string[] }
export function loadAll(cwd: string): { merged: LoadedDef[]; collisions: string[]; warnings: string[] }
export function loadGlobalConfig(): WorkspaceOptions      // ~/.pi/agent/pi-workspaces.json, tolerant
export function saveDefinition(dir: string, def: WorkspaceDefinition): Promise<void> // atomic tmp+rename
export function toWorkspaceInfo(def: WorkspaceDefinition, origin: "global" | "project"): WorkspaceInfo
export function addRoot(def: WorkspaceDefinition, name: string | null, rootPath: string): WorkspaceDefinition
export function removeRoot(def: WorkspaceDefinition, name: string): WorkspaceDefinition
```

**Behaviors:** scan skips corrupt/invalid files with warnings, missing dir -> empty; `toWorkspaceInfo` realpaths existing roots, flags `exists`; `addRoot` defaults name to basename, throws on duplicate/illegal; `removeRoot` throws on primary removal or unknown name; `loadAll` merges both sources.

**Tests (7):** scan with valid+corrupt+bad-version files; missing dir; atomic save round-trip (no .tmp left); health flags; addRoot basename/duplicate; removeRoot primary/unknown; loadAll project source.

Commit: `feat(src): add workspace store IO, health check, root operations`

### Task 5: Tool overrides — read/write/edit

**Exports (pinned):**

```typescript
export interface ToolDeps {
  getActive(): WorkspaceInfo | null
  sessionCwd(): string                              // getter, NOT a captured value
  onFirstTouch(root: RootInfo): string | null
}
export function registerToolOverrides(pi: any, deps: ToolDeps): void
```

**Behaviors:** build base via factory, spread it, override only `execute` (and append workspace syntax to `description`; one guideline line in `promptGuidelines` is ratified); `execute` resolves `params.path`, delegates to a root-bound factory instance with the resolved absolute path; write/edit serialization comes from the built-in tools' internal mutation queue (do NOT wrap `withFileMutationQueue` at the override layer: same key, non-reentrant -> deadlock, verified); resolution failures THROW `new Error(...)` (the pi harness converts throws into error results with the same content shape and flags them in the transcript; a returned `isError` flag is silently dropped by agent-core); on success touching a root, prepend `onFirstTouch` note to content (only when non-null).

**Tests (`test/tools.test.ts`, via mockPi + mockCtx):** read bare-relative vs `@b/...` returns the right fixture content; first-touch note prepended exactly once across two reads; unknown root -> isError with message; write `@b/new.txt` lands on disk; edit `@b/hello.txt` modifies on disk.

Commit: `feat(src): override read/write/edit tools with @root routing`

### Task 6: Tool overrides — grep/find/ls

**Behaviors:** same wrapper as Task 5 for the three search tools (registration = new entries in `FILE_TOOL_SPECS`); resolution failures THROW like Task 5; verify each built-in's param names against `createGrepToolDefinition/createFindToolDefinition/createLsToolDefinition` in `dist` and map the resolved path onto the right key.

**Tests (3):** grep `@b` finds fixture only there, not under `@a`; find `@b` lists fixture file; ls `@b` lists fixture entries.

Commit: `feat(src): override grep/find/ls tools with @root routing`

### Task 7: Tool override — bash with cwd parameter

**Behaviors:** spread `createBashToolDefinition` base; `parameters` is a typebox superset of the built-in schema adding optional `cwd` (description documents `@root-name/sub/dir`); `cwd` resolved via the resolver, failure THROWS like Task 5; delegate to `createBashTool(resolvedCwd)`; omitting `cwd` runs in session cwd; first-touch note applies.

**Tests (3):** `bash pwd` with `cwd: "@b"` output shows root b's dir (assert basename, shell-format agnostic); without `cwd` shows session dir; unknown root -> isError.

Commit: `feat(src): add cwd parameter to bash tool override`

### Task 8: prompt-inject

**Exports (pinned):**

```typescript
export function buildWorkspacePromptSection(ws: WorkspaceInfo, sessionCwd: string): string
export class FirstTouchTracker {
  constructor(read: (root: RootInfo) => string)
  onTouch(root: RootInfo): string | null
  reset(): void
}
export function makeConstraintReader(getPrimaryName: () => string): (root: RootInfo) => string
```

**Behaviors:** section lists `@name -> path` with `(primary)`/`(MISSING)` marks, documents relative/`@root`/absolute rules, bash `cwd`, and the constraint fallback policy; pure ASCII; tracker injects once per root until `reset()`; reader checks `AGENTS.md` then `CLAUDE.md`, else returns the primary-fallback note naming the primary root.

**Tests (3):** section content + ASCII assertion; tracker once-per-root + reset; fallback note names primary.

Commit: `feat(src): add prompt injection and first-touch constraint reader`

### Task 9: statusline

**Exports (pinned):**

```typescript
export function renderStatus(ws: WorkspaceInfo, fg: (color: string, text: string) => string): string
export function refreshStatus(ctx: any, ws: WorkspaceInfo | null): void
```

**Behaviors:** healthy: `[ws] <name> (N roots) primary: <p>`; degraded: `(ok/N roots)` + ` ! <name> missing` per missing root; colors accent/dim/warning via injected `fg`; `refreshStatus` uses key `"pi-workspaces"`, clears with `undefined` when inactive; ASCII only.

**Tests (3):** healthy format; degraded format; refreshStatus set/clear calls.

Commit: `feat(src): add workspace statusline`

### Task 10: commands

**Exports (pinned):**

```typescript
export interface CommandDeps {
  getActive(): WorkspaceInfo | null
  setActive(ws: WorkspaceInfo | null, ctx?: any): void
}
export function formatStatus(ws: WorkspaceInfo): string
export function formatList(merged: LoadedDef[]): string
export function registerWorkspaceCommands(pi: any, deps: CommandDeps): void
```

**Behaviors:** single `/workspace` command, subcommands: (none)=status, `list`, `load <name>`, `unload`, `create <name>` (cwd as sole primary root, global source), `add-root [name] <path>`, `remove-root <name>`; mutations reload the def from disk via `loadAll`, mutate, `saveDefinition` to the origin dir, then `setActive(toWorkspaceInfo(...))`; errors via `ctx.ui.notify(msg, "error")`; usage text on bad args (interactive pickers are post-MVP).

**Tests (4):** formatStatus/formatList content incl. origin + primary + MISSING; unload clears active + appends session entry; add-root mutates active workspace AND persists the JSON file (project source fixture).

Commit: `feat(src): add /workspace commands`

### Task 11: autocomplete provider

**Exports (pinned):**

```typescript
export interface CompletionItem { label: string }
export function parseAtToken(before: string): { rootPart: string; pathPart: string | null } | null
export function completeRootNames(ws: WorkspaceInfo, prefix: string): CompletionItem[]
export function completeInRoot(root: RootInfo, pathPart: string): CompletionItem[]
export function createAutocompleteProvider(getActive: () => WorkspaceInfo | null): any
```

**Behaviors:** `@` only triggers at line start or after whitespace (`a@b.com` must NOT match); stage 1 completes root names as `@name`; stage 2 completes entries inside `@root/...`, directories suffixed `/`, skipping `node_modules`/`.git`, cap 50, sorted; non-matching input delegates to `options.current`; `applyCompletion` delegates to the built-in provider (verify its exact signature in the pi docs/`dist` when wiring).

**Tests (3):** parseAtToken (4 cases incl. email rejection); completeRootNames prefix filter; completeInRoot listing/skip/cap on a temp fixture.

Commit: `feat(src): add @root autocomplete provider`

### Task 12: index.ts wiring + session activation

**Behaviors:** default-exported factory; state `active` + getter-based deps; `session_start`: `loadAll(ctx.cwd)`, notify warnings/collisions, auto-load when cwd == a workspace's primary root and `autoLoadInPrimary`, else `select` prompt when `promptInOtherDirs` && `ctx.hasUI`; `before_agent_start` appends `buildWorkspacePromptSection` only when active; register tools/commands; register autocomplete provider on `session_start` when `ctx.hasUI`; `setActive` resets tracker, refreshes status (when ctx given), `appendEntry("pi-workspaces:active", { name })`.

**Session restore:** check `ctx.sessionManager` in `dist/index.d.ts` for a custom-entry read API; if one exists, restore the recorded workspace when cwd matches none; otherwise document as post-MVP in README. Record which was done in the task report.

**Tests (`test/wiring.test.ts`, 3):** all 7 tools + command registered; `session_start` in a primary-root fixture auto-loads (entry appended); `before_agent_start` appends section when active and returns `undefined` when not.

Commit: `feat: wire extension entry with session activation`

### Task 13: README + manual smoke acceptance

- [ ] README.md (ASCII): feature tour; install global vs project (trust note, NEVER-install-both warning); workspace JSON schema (from spec 3.2); `@root/` syntax; bash `cwd`; command reference; merge rule; project-install caveat; post-MVP list (set-primary, config cmd, pickers, session restore, fs.watch).
- [ ] Smoke (only LLM-in-the-loop test): fixture two roots + `smoke.json` in `~/.pi/agent/workspaces/`; `pi -e <repo>/index.ts` from the primary root; 5 fixed prompts: (1) read `@frontend/index.html` (2) bash `pwd` with `cwd: "@frontend"` (3) write `@backend/notes.md` (4) grep under `@backend` (5) `/workspace` status. Record pass/fail per prompt; fix-forward failures as new commits.

Commit: `docs: add README with install and usage`

---

## Self-check Results

- **Spec coverage**: 3 -> Tasks 3-4; 4 -> Task 12; 5 -> Task 2; 6 -> Tasks 5-7; 7 -> Tasks 8, 12; 8 -> Task 10; 9 -> Task 11; 10 -> Task 9; 11 -> Tasks 2-4, 12; 12 -> all + Task 13; 14 -> Task 13.
- **Type consistency**: `WorkspaceInfo`/`RootInfo` (Task 2) consumed by all; `ToolDeps.sessionCwd` is a getter from the start (no retrofit); `CommandDeps.setActive(ws, ctx?)` matches Task 12 usage.
- **Placeholders**: none — contracts, behaviors, and test acceptance points are complete; the two "verify against dist/index.d.ts" items are concrete lookups, not open TODOs.
