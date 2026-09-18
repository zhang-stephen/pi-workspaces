# Plan: Autocomplete redesign (implicit current root + root switching) and /workspace argument completion

- Date: 2026-09-19
- Spec: docs/superpowers/specs/2026-09-19-autocomplete-redesign-design.md (A1-A10; read it first - the plan's rationale lives there)
- Execution: sequential, subagent-free (user preference), fine-grained tasks, one commit per task (user ruling 2026-09-19, superseding the single-commit habit)

## Global constraints

- ASCII only in code and docs; Markdown files are never manually line-wrapped (one paragraph per line).
- `node --test "test/**/*.ts"` and `npx tsc --noEmit` must pass before every commit.
- Case sensitivity: follow pi's own completion behavior exactly (case-insensitive prefix/substring matching, as pi's built-in file completion does) - no deviation in either direction.
- Display vs. insertion: `label` is what the candidate list shows (no `@` - the `@` exists only in user input), `value` is what gets inserted (always the explicit `@rootname/...` form). pi's accept path replaces the typed prefix with `value` and treats a label ending in `/` as a directory (re-trigger, no trailing space) - both verified in pi's editor source.

## T1: Switcher entries in completeRootNames

Files: src/autocomplete.ts, test/autocomplete.test.ts. Commit: feat(src): root switcher items show bare names with absolute-path descriptions.

- Label `name/` (no `@`), value `@name/`, description = absolute root path, prefix filter follows pi's case-insensitive convention.
- Tests: labels without `@`, values with `@name/`, descriptions, case-insensitive filter.

## T2: completeInRoot item descriptions

Files: src/autocomplete.ts, test/autocomplete.test.ts. Commit: feat(src): entry items carry their root-relative path as description.

- Each item gains description = path relative to the root (trailing `/` for directories); fragment filter follows pi's case-insensitive convention.
- Tests: descriptions on files and directories, case-insensitive fragment.

## T3: Provider root-less branches (the core redesign)

Files: src/autocomplete.ts, index.ts, test/autocomplete.test.ts. Commit: feat(src): implicit current root and root switching in @ completion.

- Provider signature gains `sessionCwd`; index.ts passes `ctx.cwd` at registration.
- Prefix classification: segment before the first slash exactly matches a root name -> existing explicit-root logic; otherwise the token is a current-root path. Single token (no slash) -> switchers first, then current-root top-level entries; token with slash -> current-root entries only. No current root (cwd inside no root): switchers only for single tokens, empty list for path tokens. Unknown explicit root: empty list (today's behavior).
- Current root = owningRoot(ws, sessionCwd); all values explicit `@rootname/...` per the display/insertion rule above.
- Module header comment update (stale "Task 12" reference, new interaction model).
- Tests: bare `@` with/without current root, root-less path resolution (`@tex/ch` -> `@rootname/tex/chap4.tex` value), explicit-root regression, name collision keeps both groups (A7), delegation for quoted mentions and no-workspace unchanged.

## T4: Command argument completion - subcommands and plumbing

Files: src/commands.ts, index.ts, test/commands.test.ts. Commit: feat(src): /workspace subcommand argument completion.

- CommandDeps gains `getCwd(): string` (pi's getArgumentCompletions receives only the argument text, no ctx); index.ts wires it to the sessionCwd closure.
- Subcommand table (name, one-line description, arg kind) drives first-argument completion; arg-taking subcommands complete with a trailing space so completion continues; unknown subcommand text -> null.
- AutocompleteItem type: import from the pi package if exported, otherwise a local structural type.
- Tests: full subcommand list, prefix filter, trailing-space values, unknown input -> null.

## T5: Command argument completion - load/remove/add

Files: src/commands.ts, test/commands.test.ts. Commit: feat(src): workspace, root, and path argument completion for /workspace.

- `load`: merged visible definitions minus the active workspace; description = `project` for project origin, absolute definition-file path for global origin; project scope sees no globals (D1); null when nothing remains.
- `remove`/`remove-root`: active workspace's root names (description = root path); null without an active workspace.
- `add`/`add-root`: last token completes against the filesystem (dirs + files, dirs re-trigger with `/`, pi-style case-insensitive, anchored at getCwd() for relative prefixes); a single token is a path only when it looks like one (`/`, `\`, drive letter), otherwise it is the free-form name (null); values rebuild the full argument text.
- Tests per behavior, incl. active-workspace exclusion and scope isolation.

## T6: Command description de-attribution

Files: src/commands.ts, test/commands.test.ts. Commit: refactor(src): drop the pi-workspaces prefix from the command description.

- Description loses the `pi-workspaces: ` prefix (the `[u:npm:pi-workspaces]` tag carries attribution after publication); the 16.2 comment is updated.

## T7: Verification

- Full suite + tsc green (also run before every task commit; T7 is the final gate).

## T8: Docs + commit

Files: docs/superpowers/specs/2026-09-17-pi-workspaces-design.md, README.md, README_zh.md, .superpowers/sdd progress.md. Commit: docs: sync section 9 and READMEs with the completion redesign.

- Design doc: section 9 rewritten (switchers + implicit current root + argument completion); 16.1 marked superseded by the spec (one line).
- README.md / README_zh.md "Editor autocomplete" bullets describe the new model.
- progress.md entry (unwrapped lines).

## Acceptance (from the spec)

1-5: @ behaviors per spec (switchers, current-root entries, drill-down, explicit roots unchanged, no-current-root case). 6: description without prefix. 7: argument completion per A10. 8: manual TUI checklist (switchers, both drill-down modes, argument completion, degraded statusline, palette tag) - run interactively by the user after the commits.
