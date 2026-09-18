# Spec: remove primary + activation redesign

Date: 2026-09-19. Status: approved in brainstorm, ready to implement.
Supersedes parts of `2026-09-17-pi-workspaces-design.md` (sections 3.2, 3.4, 4, 6, 9); the design doc is updated in the same batch.

## Background

After the install-scope + prompt-tightening change (commit 41417a9), a brainstorm concluded that the `primary` root concept carries more concept cost than value. Every duty it had has a more natural replacement. This spec is the decision record and the design delta.

## Decisions (brainstorm trail)

- **D1 (existing)**: install scope isolation. Only a global install (`<agentDir>/extensions/`) reads/writes global config; project installs and `-e` loads are project-scoped. Auto-load is bound by the same scope: project-scoped installs never read global definitions, not even for auto-load.
- **D2 (existing)**: a session started outside every workspace root is never prompted.
- **D3**: remove `primary` entirely. A workspace is an unordered set of equal roots.
- **D4**: `activation: "auto" | "prompt"` replaces `autoLoadInPrimary`/`promptInOtherDirs`. Built-in default: `"auto"`. `auto` = load silently when the cwd is inside any root; `prompt` = ask. Multiple workspaces containing the cwd always prompt (disambiguation).
- **D5**: project source discovery ascends from the cwd and stops at the first directory containing any root marker (`.pi`, `.git`, `.agents`). If that directory has no `.pi/workspaces` subdirectory or it is empty, the project source contributes no definitions - it is simply absent from the auto-load/prompt candidate pool (no error, no further ascent into outer projects). Cap: `projectRootAscend` levels (built-in default 3; lives in the global defaults config, so project-scoped installs always use the built-in value). Never ascend above the user's home directory.
- **D6**: constraint fallback chain = touched root's own AGENTS.md/CLAUDE.md -> session root (the root containing the cwd) -> none. Unrelated loads have no session root, hence no fallback (the cwd's own constraints already reach the model via pi's native project instructions; injecting them into tool results would be noise and semantically wrong).
- **D7**: `/workspace load` of a workspace whose roots do not contain the cwd warns ("bare relative paths stay anchored at the session directory") but proceeds. Gated by `warnOnUnrelatedLoad` (built-in default true).
- **D8**: `remove-root` protects the last remaining root (replaces primary protection).
- **D9**: breaking change, no tolerance. Definitions still containing the removed `primary` field or the removed option keys (`autoLoadInPrimary`, `promptInOtherDirs`) are **rejected** with an explanatory error naming the offending key. No silent ignoring, no migration. The user's own definition files (e.g. `~/.pi/agent/workspaces/*.json`) must be migrated by hand when this lands.
- **D10**: same batch also fixes recorded items 16.2 (command source attribution), 16.3 (`add`/`remove` aliases), 16.4 (constraint self-injection duplicates content), 16.5 (journal entries duplicate on repeated session_start). Item 16.1 (autocomplete vision) is deferred to the next batch.

## Design deltas per module

### workspace-store.ts

- `WorkspaceDefinition`: drop `primary`. `WorkspaceOptions` = `{ activation?: "auto" | "prompt"; warnOnUnrelatedLoad?: boolean }`. Validation: `activation` must be one of the two strings when present; `warnOnUnrelatedLoad` boolean; a definition still carrying `primary` or the legacy option keys is rejected with an error naming the key (D9).
- `BUILTIN_DEFAULTS` = `{ activation: "auto", warnOnUnrelatedLoad: true }`.
- New `discoverProjectDir(cwd, ascend)`: walk up from cwd at most `ascend` levels, stop at the first directory containing any root marker (`.pi`, `.git`, `.agents`); never cross above the user's home directory. The nearest marker directory wins even when it has no `.pi/workspaces` subdirectory (or it is empty) - that simply means the project source is empty and contributes no auto-load/prompt candidates (no error, no further ascent into outer projects). When no ancestor within the cap has a marker, the project dir is the cwd itself.
- Project source = `discoverProjectDir(cwd)/.pi/workspaces`.
- Global defaults config gains optional `projectRootAscend` (number). Only read in global scope (chicken-and-egg: the cap controls how definitions are found).

### path-resolver.ts

- `WorkspaceInfo` drops `primary`. Nothing else changes: `@root/` resolution, containment, longest-prefix attribution are all primary-free already.

### prompt-inject.ts

- `buildWorkspacePromptSection`: root map without `(primary)` marks; constraint policy text describes the session-root fallback ("roots without either file fall back to the constraints of the root containing the session directory"; when the cwd is inside no root, the sentence says there is no fallback).
- `makeConstraintReader(ws, sessionCwd)`: resolve the touched root's own AGENTS.md then CLAUDE.md; else the session root's AGENTS.md then CLAUDE.md; else none.
- 16.4 fix: when the resolved target file IS the constraint file about to be injected, skip the injection (reading `@yolo/AGENTS.md` must not print the file twice).

### statusline.ts

- Format: `[ws] <name> (N roots)`; degraded: `[ws] <name> (2/3 roots) ! frontend missing`. No primary segment.

### commands.ts

- `add` / `remove` become first-class aliases of `add-root` / `remove-root` (long forms keep working; usage text lists the short forms).
- `load`: after resolving the definition, when the cwd is inside none of its roots and `warnOnUnrelatedLoad` resolves true, emit a warning notification naming the cwd anchor; activate regardless.
- `create`: definition without `primary`; single root named after the cwd basename (existing safe-alphabet fallback).
- `remove-root`: refuse when the workspace has exactly one root ("cannot remove the last root").
- `status`/`list` output drops primary mentions.
- 16.2: verify whether pi's command palette renders the extension sourceInfo tag for directory installs (npm packages show `[u:npm:...]`). If it does not, append `(pi-workspaces)` to the command description as a fallback. Decision recorded after a live check.

### index.ts

- session_start flow:
  1. scan visible sources (scope-gated; project source via discovery)
  2. containing = definitions where the cwd is inside any root
  3. exactly one containing with `activation: "auto"` -> auto-load
  4. otherwise, containing >= 1 and hasUI -> select over all containing + "Don't load" (covers `prompt` workspaces and multi-match disambiguation)
  5. containing == 0 -> nothing (D2)
  6. journal restore unchanged (resume)
- 16.5 fix: `setActive` skips `appendEntry` when the last journaled `pi-workspaces:active` entry already names the same workspace (reload-safe).

## Acceptance criteria

- `node --test "test/**/*.ts"` green, including new tests: ascend discovery (cap, home guard, subdir start), activation auto/prompt, multi-match disambiguation, no-prompt outside roots, unrelated-load warning, last-root protection, 16.4/16.5 regressions, legacy-key rejection (D9).
- `npx tsc --noEmit` clean.
- Headless dry runs (RPC): auto-load from a non-primary root with activation auto; zero visibility under `-e` from an unrelated repo; global install unaffected.
- Manual TUI checklist re-run after the refactor (statusline, autocomplete, select, /resume, /reload).

## Docs

README.md + README_zh.md (schema, activation, discovery, commands, options), design doc sections 3.2/3.3/3.4/4/6/9 + decision record, progress.md.
