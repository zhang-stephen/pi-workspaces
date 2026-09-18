# Spec: Autocomplete redesign - implicit current root + root switching

- Date: 2026-09-19
- Status: draft (pending user review)
- Supersedes: design doc 16.1 (original fuzzy cross-root vision - replaced by this interaction model)
- Precedes: an implementation plan derived from this spec
- Out of scope: the npm publishing flow itself (decided separately, see design doc 16.2 FOLLOW-UP)

## Problem and solution summary

Today the @root autocomplete provider requires knowing which root a file lives in: `@` alone offers only root names, and only an explicit `@rootname/` prefix lists that root's entries. Files in the root containing the session directory - the most common target - still need the full `@rootname/path` dance.

Redesign the provider so that `@` offers both the root names (as switcher entries) and the entries of the **current root** (the workspace root containing the session directory). Selecting a root name switches the completion into that root, where the existing path-prefix logic applies unchanged. Selecting a current-root entry behaves exactly as if the current root had been named explicitly.

## Scope

- In: `src/autocomplete.ts` provider redesign + tests; `/workspace` command description de-attribution; design doc 16.1 superseded note; manual TUI checklist as acceptance.
- Out: npm publishing; fuzzy/subsequence matching across whole trees; any change to path resolution, activation, or the other modules.

## Decisions

- **A1 (interaction model)**: `@` (empty or root-less prefix) offers two groups: (1) every root name as a switcher entry - label `@name/` (trailing slash, so accepting it continues straight into that root), description = the root's absolute path (mirroring how file candidates show their relative path); (2) the current root's entries, completed with the existing path-prefix logic. The current root is `owningRoot(ws, sessionCwd)`; when the session directory is inside no root, group 2 is absent and only root names are offered.
- **A2 (root switching)**: selecting a root name inserts `@name/` and re-triggers completion under that root. From then on the ORIGINAL path-prefix logic applies unchanged - no fuzzy matching anywhere.
- **A3 (current-root entries)**: selecting a current-root directory drills down; selecting a file completes. The continuation text after the trigger is rooted at the current root, so drilling down produces `@tex/ch` style text which must resolve against the current root (not the session cwd) - the provider rewrites the inserted text to the explicit `@rootname/...` form on every accepted completion (see A4).
- **A4 (insertion)**: every accepted completion inserts the explicit `@rootname/relative/path` form, including for current-root entries. The final text is always self-contained and resolvable by the tool overrides regardless of the session cwd. (Directories end with `/` and re-trigger, as today.)
- **A5 (matching)**: unchanged - case-insensitive prefix on the entry name, one directory level at a time. No tree walking, no index, no fuzzy search (YAGNI; the ch4.tex incident was a filename misremembering, not a discovery failure).
- **A6 (ordering and volume)**: root switchers first, then current-root entries in the existing order (directories first, then files, alphabetical within a group - i.e. readdir order semantics preserved). The provider returns all matches; pi handles visibility (autocompleteMaxVisible) as it does today.
- **A7 (dedupe)**: when a current-root entry name collides with a root name, both stay; they are distinguishable by description (absolute path vs relative path).
- **A8 (side task)**: drop the `pi-workspaces: ` prefix from the /workspace command description. Once published to npm, the palette's `[u:npm:pi-workspaces]` tag carries the attribution; the in-description prefix becomes redundant. (Until publication the tag is a bare `[u]` - accepted trade-off, the user owns the timeline.)
- **A9 (docs)**: design doc 16.1 is marked superseded by this spec; section 9 is rewritten to describe the new interaction model.
- **A10 (command argument completion)**: the /workspace command gains `getArgumentCompletions` (natively supported by pi: it receives the full argument text after the command name, and the chosen item's `value` replaces that whole text - source-verified in pi's `applyCompletion`). Completion levels: first argument -> subcommand names (status/list/load/unload/create/add/add-root/remove/remove-root) with their one-line descriptions; accepting a subcommand that takes arguments inserts a trailing space so completion continues. `load <prefix>` -> the merged visible definitions (project source for the current directory + global source), EXCLUDING the currently active workspace when there is one (loading it would be a no-op); description: project-origin items show `project`, global-origin items show the absolute path of the global definition file (distinguishes personal workspaces); project-scoped installs never see global items at all (scope isolation, D1 - globals are treated as nonexistent). When nothing remains after filtering, return null (no popup). `remove`/`remove-root <prefix>` -> root names of the ACTIVE workspace, description = root path; no active workspace -> null. `add`/`add-root [name] <path>` -> the path argument completes directories AND files against the filesystem, anchored at the session cwd for relative prefixes (pi offers no fallback path completion inside command arguments, so without this there would be none); directories re-trigger with a trailing `/`. Quoted paths and paths containing spaces are not specially handled (KISS; noted as a limitation).

## Current state

`src/autocomplete.ts` - `createAutocompleteProvider(getWorkspace, sessionCwd)`:

- Trigger: last `@` before the cursor in the current line; text before it must be blank or end in whitespace.
- Empty prefix: one item per root, label `@name`, description `root.path`, no trailing slash (the user continues typing).
- `root/rest` prefix: the root's directory entries one level at a time, directories with a trailing `/`; the typed prefix is a path; matching is a case-insensitive prefix on the entry name. Missing/unreadable directories yield no items (null).
- Items carry `description` (relative path from the root) and `detail` ("Directory"/"File").

## Target design

Same module, same entry points (index.ts wiring is untouched). The provider splits the post-`@` prefix into "contains a slash after a root name" (existing behavior) vs "root-less" (new behavior):

```
prefix parse:
  "@rootname/rest" with rootname matching a root -> existing per-root logic (A2)
  anything else (no recognized root name before the first slash, or no slash):
      candidates = root switchers (all roots, filtered by prefix on the name)
                 + current-root entries (typed prefix interpreted as a path inside
                   the current root, existing one-level logic; A1, A5)
```

Wait - careful: `@tex/ch` has a slash but `tex` is not a root name. The parser must treat it as a current-root path, not fail. Rule: if the segment before the first `/` matches a root name (exact match, roots are addressed verbatim today), use the explicit-root path; otherwise interpret the whole prefix as a current-root path. This preserves today's behavior for explicit roots and adds the implicit current root everywhere else.

Insertion mechanics (V1, RESOLVED by reading pi's editor source): on accept, pi replaces the typed trigger-to-cursor prefix with the item's `value` (not its label). For `@` prefixes, a directory (label ending in `/`) gets no suffix and re-triggers completion; a file gets a trailing space appended. `AutocompleteItem` is `{ value, label, description? }`. So the redesign works by giving every item an explicit `@rootname/...` value: accepting any current-root or other-root entry always yields self-contained, tool-resolvable text (A4). Switcher items use value `@name/`, so accepting a root name immediately continues into that root (the old "type the slash yourself" step disappears).

## Module changes

- `src/autocomplete.ts`: new parse step distinguishing explicit-root prefixes from current-root prefixes; root switchers get label `@name/` with description = absolute root path (A1); current-root completion reuses the existing directory-listing helper with the current root as base, labels in the explicit `@currentroot/...` form (A4); no current root (cwd outside every root) means switchers only (A1); trigger/extraction logic and readdir semantics unchanged.
- `src/commands.ts`: description loses the `pi-workspaces: ` prefix; the 16.2 comment is updated (npm tag carries attribution post-publication). Adds `getArgumentCompletions` per A10.
- `index.ts`, `src/tools.ts`, other modules: untouched.

## Documentation

- Design doc section 9 rewritten for the new interaction model.
- Design doc 16.1 marked superseded by this spec (one line).
- README/README_zh autocomplete description updated (they currently document `@root/...` explicit completion).

## Acceptance criteria

1. Typing `@` in a session whose cwd is inside a root offers all root names (with absolute-path descriptions) plus the current root's top-level entries.
2. Selecting a root name completes to `@name/` and the next trigger lists that root's top-level entries - the existing drill-down behavior from there.
3. Typing `@tex/ch` with cwd inside a root that has `tex/chap4.tex` offers `@rootname/tex/chap4.tex` (explicit label), and accepting it produces that exact text - resolvable by the read tool.
4. Typing `@alpha/src/` (explicit root) behaves exactly as before.
5. cwd outside every root: `@` offers root switchers only.
6. The /workspace command description no longer contains `pi-workspaces:`.
7. Command argument completion (A10): `/workspace ` offers all subcommands; `/workspace load ` offers the visible workspace names minus the active one (project items described as `project`, global items with their absolute definition path; project scope shows no globals); `/workspace remove ` offers the active workspace's root names; `/workspace add foo src/fr` completes filesystem entries under the session cwd.
8. Manual TUI checklist (carried over from the no-primary post-batch list): run pi interactively with an active multi-root workspace; verify @ switchers, @ current-root entries, drill-down in both modes, command argument completion, the degraded statusline, and the command palette tag.

## Tests

- `test/autocomplete.test.ts` (existing suite, extended): bare `@` with a current root offers switchers (label `@name/`, description = abs path) followed by current-root top-level entries; bare `@` without a current root offers switchers only; `@<prefix>` filters both groups case-insensitively; `@tex/ch`-style root-less path prefixes resolve inside the current root and label items explicitly (`@rootname/tex/chap4.tex`); explicit `@rootname/...` behavior unchanged (existing tests keep passing); a name collision between a root name and a current-root entry keeps both (A7).
- `test/commands.test.ts`: description assertion without the prefix; getArgumentCompletions cases (subcommand list; load names excluding the active one, with project/global descriptions and scope isolation; remove root names with active/no-active workspace; add path completion).
- No changes needed in other test files.

## Risks / edge cases

- Large current-root directories: unchanged behavior (provider returns all matches, pi caps visibility). No new performance surface.
- A current-root path prefix that never matches yields only switcher candidates - acceptable, same as today's empty explicit-root listing.
- Argument completion replaces the WHOLE argument text (pi semantics), so multi-argument subcommands (add) must rebuild the full argument string in each item's value - covered by the A10 tests.
