# pi-workspaces

**English** | [中文](README_zh.md)

Multi-root workspaces for the [pi coding agent](https://pi.dev). A workspace merges several directories ("roots") into one named unit, so a single pi session can read, write, search, and run shell commands across all of them - VS Code-style multi-root folders, but for your agent.

When no workspace is active the extension does nothing at all: every tool behaves exactly like stock pi.

## Feature tour

- **Multi-root file tools.** The built-in `read`, `write`, `edit`, `grep`, `find`, and `ls` tools gain a `@root-name/` path prefix that routes the call into any workspace root. Everything else about the tools (rendering, write serialization, result shape) is inherited from the built-ins.
- **Cross-root shell.** The `bash` tool gains an optional `cwd` parameter that accepts an absolute path or `@root-name/sub/dir`, spawning the command inside that root. Per-call cwd is safe because pi spawns a fresh shell process per call.
- **Prompt injection.** While a workspace is active, a workspace section (root map, syntax rules, bash usage, constraint policy) is appended to the system prompt. The first time a root is touched in a session, that root's AGENTS.md / CLAUDE.md is appended to the tool result (once per root per session); roots without their own constraint files fall back to the session root's (the root containing the session directory), and reading a constraint file itself never double-injects it.
- **Editor completion.** Typing `@` offers root switchers plus the files of the current root (the one containing your session directory) - select a root to drill into it, or keep typing a path without naming a root; every accepted item inserts the explicit `@root-name/path` form. `/workspace` also completes its arguments: subcommands, workspace names for `load` (minus the active one), root names for `remove`, and filesystem paths for `add`. Everything else delegates to pi's built-in completion. (Completion only helps paths you type - the model generates tool-call paths on its own.)
- **Footer statusline.** A keyed footer entry shows the active workspace at a glance: `[ws] <workspace> (3 roots)`. When a root directory is missing on disk the status degrades: `[ws] <workspace> (2/3 roots) ! <root>missing`. The entry is cleared when no workspace is active.
- **Durable session state.** The active workspace is journaled into the session file, so `/resume` restores it.
- **Headless-friendly.** All `/workspace` commands work in RPC mode, where interactive notifications are emitted as JSON events - usable for scripting and automated smoke tests.

## Installation

The extension is a TypeScript directory loaded directly by pi (no build step). Copy the whole directory - `index.ts` plus `src/` - into exactly one of the two auto-discovered locations:

### Global (personal, cross-project)

```
~/.pi/agent/extensions/pi-workspaces/index.ts
```

Loads in every session, no matter which directory it starts in. Best for your own machine and personal workspaces.

### Project-level (bound to one repository)

```
<repo>/.pi/extensions/pi-workspaces/index.ts
```

Loads only for sessions started inside that repository. Suitable for team-shared setups: the extension travels with the repo.

**Trust note.** Project-local `.pi/extensions` entries load only after the project is trusted. pi resolves trust from saved `trust.json` decisions first, then its `defaultProjectTrust` setting decides whether it asks, trusts, or declines. Until the project is trusted the extension simply is not loaded.

> [!WARNING] Never install in both locations at once!
> pi auto-discovers both directories and loads **two instances** of the extension. The seven tool overrides then double-register (`bash`, `read`, `write`, ...), which breaks tool dispatch and rendering. Pick exactly one location per machine-and-repo setup; if you ever migrate, delete the other copy first.

### Install scope decides what you can see

The extension detects how it was loaded and scopes all config access accordingly:

| How it was loaded | Definition sources | Config file | `/workspace create` writes to |
|---|---|---|---|
| Global install (`~/.pi/agent/extensions/`) | global + project (merged by name) | read | global source |
| Project install (`<repo>/.pi/extensions/`) | project only | never read | project source |
| `pi -e <path>` (dev loop) | project only | never read | project source |

A project-scoped load never reads or writes anything under `~/.pi/agent/` - not the workspace definitions, not the config file. Your personal global workspaces stay invisible to a repo-shared extension install, and the development loop (`pi -e ...`) behaves the same way. To develop against global definitions, install the extension globally for real.

## Quick start

```text
/workspace create my-project     # current dir becomes the first root
/workspace add-root frontend C:/repos/frontend
/workspace add-root backend C:/repos/backend
```

Or hand-write a definition file (see the schema below) into `~/.pi/agent/workspaces/` (global, personal) or `.pi/workspaces/` inside your project (shareable via git). Then start pi inside any root - or use `/workspace load my-project`.

## Workspace definitions

Definitions are JSON files, one workspace per file. A workspace is an **unordered set of equal roots** - there is no primary root:

- Global source: `~/.pi/agent/workspaces/<name>.json` (visible to global installs only)
- Project source: `.pi/workspaces/<name>.json` inside the discovered project directory (visible to every install scope). The project directory is found by **marker ascent**: from the session directory, walk up at most `projectRootAscend` levels (built-in default 3) and stop at the first directory containing a `.pi`, `.git`, or `.agents` marker. The nearest marker wins even without a `.pi/workspaces` subdirectory (the project source is then simply empty); discovery never ascends above your home directory, and with no marker inside the cap the session directory itself is used.

### Schema

```json
{
  "name": "my-workspace",
  "version": 1,
  "roots": [
    { "name": "backend",  "path": "C:/repos/backend" },
    { "name": "frontend", "path": "C:/repos/frontend" }
  ]
}
```

- `name`: workspace name. Must match `^[A-Za-z0-9_-]+$` (letters, digits, `-`, `_`; no path separators).
- `version`: schema version, currently `1`. Files with an unknown version are skipped silently at startup (visible via `/workspace list`).
- `roots`: non-empty array of root objects. Each root has a `name` (same pattern, unique within the workspace) and an absolute `path`. Illegal or duplicate root names reject the whole definition. On Windows, write paths with forward slashes (`C:/repos/backend`) - JSON does not accept `\U`-style escapes, so backslash paths are invalid.
- Definitions carry no options - the schema is `name`/`version`/`roots` only, and any other top-level key (including the removed `options`) rejects the file with the key named.

Validation rejects malformed files with an explanatory error; at startup a corrupt or incompatible file is skipped **silently** - it surfaces through `/workspace list`, which re-scans and reports (broken files must not pollute unrelated sessions). All writes back to definition files are atomic (temp file + rename).

### Config and the resolution chain

The plugin config is one flat struct. The global file is `~/.pi/agent/pi-workspaces.json`; a project can override individual keys via `<project>/.pi/pi-workspaces.json`:

```json
{
  "activation": "auto",
  "warnOnUnrelatedLoad": true,
  "projectRootAscend": 3
}
```

Each key resolves independently, project first, then the global file, then the built-in value; a missing or wrong-typed value silently falls through:

```text
project config.<key>  ??  global config.<key>  ??  built-in default
```

Built-in defaults: `activation: "auto"`, `warnOnUnrelatedLoad: true`, `projectRootAscend: 3`.

- `activation`: `"auto"` loads the workspace silently when the session starts inside any of its roots; `"prompt"` asks first. When several workspaces contain the session directory, pi always asks (disambiguation), even if the config says `"auto"`. Activation is a property of the project/directory context - it cannot be set per workspace.
- `warnOnUnrelatedLoad`: when `/workspace load` activates a workspace whose roots do not contain the session directory, warn that bare relative paths stay anchored at the session directory. The load proceeds either way.
- `projectRootAscend` (global-only): the ascent cap for project-source discovery. It lives only in the global config - it controls how definitions are found, so a project-level override would be circular (a project-level value is ignored), and project-scoped installs always use the built-in value.

## Path syntax and bash cwd

With a workspace active, tool paths accept three forms:

1. `@root-name/relative/path` - resolved against that root's absolute path. The result must stay inside the root: `@backend/../../etc` is rejected with an error stating the containment rule. An unknown root name produces an error listing the available roots.
2. **Bare relative path** - resolves against the session start directory (`ctx.cwd`), exactly like stock pi. This rule never changes.
3. **Absolute path** - works everywhere. Inside a root it is attributed to the longest-prefix matching root; outside all roots it passes through unchanged (stock pi behavior; writes outside all roots are allowed).

The `bash` tool's `cwd` parameter accepts the same three forms; when omitted, the command runs in the session start directory:

```text
bash(command: "npm test", cwd: "@frontend")
bash(command: "git status", cwd: "C:/repos/backend")
bash(command: "pwd")                 # session start directory
```

Resolution failures are thrown as tool errors the model can see and self-correct from.

## How workspaces activate

At `session_start` the extension scans the definition sources visible to its install scope and then:

1. **Auto-load**: if exactly one workspace contains the session directory (inside any root) and the session config's `activation` resolves to `"auto"`, that workspace loads immediately. If the loaded workspace's name exists in both sources, an info line notes that the project definition wins.
2. **Journal restore**: if the session is a `/resume`, the last recorded active workspace is re-activated. Repeated `session_start` events (e.g. extension reloads) never duplicate the journal entry.
3. **Ask**: otherwise, if at least one workspace contains the session directory, pi prompts with exactly those workspaces plus a "Don't load" escape hatch - this covers `activation: "prompt"` projects and multi-match disambiguation. A session started outside every workspace root is **never** prompted - loading from an unrelated directory is always an explicit `/workspace load` (which warns by default, see `warnOnUnrelatedLoad`).

Broken definition files never produce startup warnings: diagnostics surface only when you run `/workspace list`, which re-scans and reports. The one exception tied to your directory: if the session directory matches only a **shadowed** definition (the losing side of a name collision), pi warns that the project source overrides it and loads nothing.

Only one workspace can be active at a time; loading another replaces the current one (with a notification).

## Command reference

All commands are `/workspace` subcommands; output is shown via pi notifications.

| Command | Behavior |
|---------|----------|
| `/workspace` (or `status`) | Show the active workspace: name, origin, and every root with a `(MISSING)` marker when its directory is gone. |
| `/workspace list` | List all definitions from both sources, each with its `origin` (`global` or `project`). |
| `/workspace load <name>` | Activate a workspace by name. Warns when its roots do not contain the session directory (`warnOnUnrelatedLoad`); loads either way. |
| `/workspace unload` | Deactivate the active workspace; the statusline clears. |
| `/workspace create <name>` | Create a definition with the current directory as its sole root, and activate it. Saved to the source matching the install scope (global installs: global source; everything else: project source). |
| `/workspace add [name] <path>` | Add a root to the active workspace (alias: `add-root`). The name is optional (derived from the directory basename when omitted); a relative path anchors at the session directory. The definition is persisted back to its origin source. |
| `/workspace remove <name>` | Remove a root from the active workspace and persist (alias: `remove-root`). The last remaining root cannot be removed. |

Interactive argument pickers (for example a fuzzy `load` picker) are post-MVP - missing arguments print usage text instead.

## Headless usage (print / RPC mode)

All commands work headless, which is also how this extension is smoke-tested. Two things to know:

- **Use RPC mode to observe command output.** In print mode (`pi -p`), `ctx.ui.notify` is a no-op, so command output is invisible. In RPC mode (`pi --mode rpc`), every notification and statusline update is emitted as a JSON event: `printf '%s\n' '{"type":"prompt","message":"/workspace list"}' | pi --mode rpc`.
- **Windows / Git Bash argument mangling.** When passing a slash command as an argument (e.g. `pi -p "/workspace list"`), MSYS path conversion rewrites `/workspace` into `C:/Program Files/Git/workspace`. Set `MSYS_NO_PATHCONV=1` (or `MSYS2_ARG_CONV_EXCL="*"`) first.
- **No prompts headless.** The select-list activation step requires a UI; headless sessions rely on auto-load (start pi inside any root of an `activation: "auto"` workspace) or journal restore (`-c` / `/resume`). `pi -c` ignores session files that contain no messages.
- **Piped RPC prompts are not serialized.** pi does not await one piped prompt's command handler before starting the next, so mutating commands issued back-to-back in one batch can race on the definition file. Send mutating commands one at a time (interactive use is unaffected).

## How definitions merge

A global install scans both sources at `session_start` and merges **by name**: a project definition overrides a global definition of the same name, and the project source wins per name. A wholesale override never happens - a project file cannot hide your unrelated global workspaces; they keep loading side by side. Project-scoped installs (project install or `-e` dev load) see only the project source, so no merging applies to them.

- Each merged definition records its `origin` (`global` or `project`), shown by `/workspace list` and `/workspace status`.
- Collision notices are relevance-gated: an info line ("the project definition wins") appears only when a collided workspace actually activates (auto-load, journal restore, prompt selection, `/workspace load`); a directory matching only the shadowed global copy warns without loading; everything else stays silent.

## Project-level install caveats

A project-level install has two consequences, both expected behavior rather than bugs:

- **Discovery**: pi discovers project extensions from the session's own directory, so the extension loads only when the session starts inside that repository. Sessions started elsewhere - including inside another root of the same workspace - have no auto-load, prompts, tool overrides, or statusline. Use a global install if you want the extension everywhere.
- **Isolation**: a project-level install (like an `-e` dev load) is project-scoped: it sees only the discovered project source (`.pi/workspaces/` under the nearest marker directory) and never reads or writes the global config under `~/.pi/agent/`. A repo-shared extension cannot peek at your personal workspaces.

## Storage locations

| What | Where |
|------|-------|
| Global definitions | `~/.pi/agent/workspaces/*.json` (global installs only) |
| Project definitions | `.pi/workspaces/*.json` inside the discovered project directory (all install scopes) |
| Global default options | `~/.pi/agent/pi-workspaces.json` (global installs only) |
| Active-workspace journal | inside the pi session file (custom entry `pi-workspaces:active`) |

## Known limitations

- **pi-fff conflict.** With `@ff-labs/pi-fff` (or any fork carrying its mention provider) in its default `tools-and-ui` mode, its own @ fuzzy search answers every `@` query and pi-workspaces' root completion never surfaces. Switch pi-fff to its `tools-only` mode (`/fff-mode tools-only`) to restore pi-workspaces' @ completion.

- **Explicit `cwd` drops session env vars.** A `bash` call with an explicit `cwd` runs without the `PI_*` session environment variables (passing the runtime ctx through would override the resolved directory). Calls without `cwd` - the default branch - do inject them.
- **Symlinked definition files are skipped.** The source scan only accepts regular `.json` files, so a workspace definition that is a symbolic link is silently ignored (use a real file or a link to the directory).
- **Symlinked directories complete as files.** Inside a root, the autocomplete provider classifies entries by the directory flag, so a symlinked subdirectory is offered without a trailing `/`.

## Post-MVP roadmap

Not in this version, planned or desired later:

- `/workspace config` - edit the global default options (`~/.pi/agent/pi-workspaces.json`) from within a session.
- Interactive pickers - create wizard and argument-less `load` picker.
- `fs.watch` hot-reload of definition files (today definitions are read once at `session_start`; use `/workspace load` to re-read).
- Cross-root aggregated search conveniences (one grep across all roots with merged results).

## Development

```bash
# Load the extension in development mode from any directory
pi -e /path/to/pi-workspaces/index.ts

# Run tests
node --test "test/**/*.ts"
```

TypeScript loaded directly by pi via jiti - no build step, no third-party runtime dependencies (Node built-ins + pi exports only).
