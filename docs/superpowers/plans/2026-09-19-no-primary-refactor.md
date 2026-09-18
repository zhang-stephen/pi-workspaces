# Plan: remove primary + activation redesign

Spec: `docs/superpowers/specs/2026-09-19-no-primary-refactor-design.md` (read first).
Execution: sequential, one commit at the end (code + tests + docs together, plus the pending section-16 record from the previous round).

## T1. workspace-store: schema + discovery

- Remove `primary` from `WorkspaceDefinition`; definitions still carrying it (or the legacy option keys `autoLoadInPrimary` / `promptInOtherDirs`) are **rejected** with an explanatory error naming the key - breaking change, no tolerance (D9).
- Migration note: hand-edit `~/.pi/agent/workspaces/*.json` (thesis/smoke/ghost carry `primary`) when this lands.
- `WorkspaceOptions` = `activation` (`"auto" | "prompt"`) + `warnOnUnrelatedLoad` (boolean); tolerate legacy option keys.
- `BUILTIN_DEFAULTS = { activation: "auto", warnOnUnrelatedLoad: true }`.
- `discoverProjectDir(cwd, ascend)`: markers `.pi`/`.git`/`.agents`, nearest wins, cap levels, never above home.
- Project source = `discoverProjectDir(...)"/.pi/workspaces"`; global defaults config accepts `projectRootAscend` (number, global scope only).
- Tests: store-io gains ascend cases (cap hit, home guard, subdir start, no-marker fallback to cwd) and legacy-key rejection cases.

## T2. path-resolver: drop primary from WorkspaceInfo

- Remove the field; fix `toWorkspaceInfo` and all consumers.

## T3. prompt-inject: session-root fallback + self-injection skip

- `makeConstraintReader(ws, sessionCwd)`: touched root's AGENTS.md/CLAUDE.md -> session root's -> none.
- Section text: root map without `(primary)`; policy sentence describes the session-root fallback (or its absence).
- Skip injection when the target file is the constraint file itself (16.4).
- Tests: fallback chain incl. unrelated-load (no fallback), self-read skip.

## T4. statusline: drop primary segment

- `[ws] name (N roots)`; degraded format unchanged apart from that.
- Tests updated.

## T5. commands: aliases, load warning, create, last-root protection

- `add`/`remove` aliases; usage text updated.
- `load` unrelated-cwd warning via `warnOnUnrelatedLoad`.
- `create` without `primary`.
- `remove-root` refuses to remove the last root.
- Live-check pi palette sourceInfo rendering for directory installs; fallback = append `(pi-workspaces)` to the description (16.2).
- Tests updated + new (alias dispatch, load warning on/off, last-root refusal).

## T6. index: activation flow + journal idempotency

- Containing-set activation per spec (auto single-match, prompt otherwise, never outside roots).
- `setActive` journal dedupe (16.5).
- Wire discovery into session_start (project source).
- Tests updated + new (auto from non-primary root, multi-match prompt, dedupe).

## T7. Full verification

- `node --test "test/**/*.ts"` + `npx tsc --noEmit`.
- Headless RPC dry runs per spec acceptance.

## T8. Docs + commit

- README.md / README_zh.md updates (schema, activation, discovery, commands, options, statusline format).
- Design doc sections 3.2/3.3/3.4/4/6/9 synced + decision record section.
- progress.md entry; commit everything (includes the previously uncommitted section-16 record).

## Post-batch (not here)

- 16.1 autocomplete vision (roots pinned above cwd files with `[root]: <abs path>` annotations).
- Manual TUI checklist re-run.
