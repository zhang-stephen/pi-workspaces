# pi-workspaces

**English** | [中文](README_zh.md)

Multi-root workspaces for the [pi coding agent](https://pi.dev). A workspace merges several directories ("roots") into one named unit, so a single pi session can read, write, search, and run shell commands across all of them - VS Code-style multi-root folders, but for your agent.

When no workspace is active the extension does nothing at all: every tool behaves exactly like stock pi.

## Feature tour

- **Multi-root file tools.** The built-in `read`, `write`, `edit`, `grep`, `find`, and `ls` tools gain a `@root-name/` path prefix that routes the call into any workspace root. Everything else about the tools (rendering, write serialization, result shape) is inherited from the built-ins.
- **Cross-root shell.** The `bash` tool gains an optional `cwd` parameter that accepts an absolute path or `@root-name/sub/dir`, spawning the command inside that root. Per-call cwd is safe because pi spawns a fresh shell process per call.
- **Prompt injection.** While a workspace is active, a workspace section (root map with the primary marked, syntax rules, bash usage, constraint policy) is appended to the system prompt. The first time a root is touched in a session, that root's AGENTS.md / CLAUDE.md is appended to the tool result (once per root per session); roots without their own constraint files fall back to the primary root's.
- **Editor autocomplete.** Typing `@` in the prompt editor offers root names; after `@root-name/` it completes file and directory paths inside that root. Everything else delegates to pi's built-in completion. (This only helps paths you type - the model generates tool-call paths on its own.)
- **Footer statusline.** A keyed footer entry shows the active workspace at a glance: `[ws] my-workspace (3 roots) primary: backend`. When a root directory is missing on disk the status degrades: `[ws] my-workspace (2/3 roots) primary: backend ! frontend missing`. The entry is cleared when no workspace is active.
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

> **WARNING: never install in both locations at once.**
> pi auto-discovers both directories and loads **two instances** of the extension. The seven tool overrides then double-register (`bash`, `read`, `write`, ...), which breaks tool dispatch and rendering. Pick exactly one location per machine-and-repo setup; if you ever migrate, delete the other copy first.

## Quick start

```text
/workspace create my-project     # current dir becomes the primary root
/workspace add-root frontend C:/repos/frontend
/workspace add-root backend C:/repos/backend
```

Or hand-write a definition file (see the schema below) into `~/.pi/agent/workspaces/` (global, personal) or `<repo>/.pi/workspaces/` (project, shareable via git). Then start pi inside any root - or use `/workspace load my-project`.

## Workspace definitions

Definitions are JSON files, one workspace per file:

- Global source: `~/.pi/agent/workspaces/<name>.json`
- Project source: `<repo>/.pi/workspaces/<name>.json`

### Schema

```json
{
  "name": "my-workspace",
  "version": 1,
  "roots": [
    { "name": "backend",  "path": "C:/repos/backend" },
    { "name": "frontend", "path": "C:/repos/frontend" }
  ],
  "primary": "backend",
  "options": {
    "autoLoadInPrimary": true,
    "promptInOtherDirs": true
  }
}
```

- `name`: workspace name. Must match `^[A-Za-z0-9_-]+$` (letters, digits, `-`, `_`; no path separators).
- `version`: schema version, currently `1`. Files with an unknown version are skipped with a warning.
- `roots`: non-empty array of root objects. Each root has a `name` (same pattern, unique within the workspace) and an absolute `path`. Illegal or duplicate root names reject the whole definition. On Windows, write paths with forward slashes (`C:/repos/backend`) - JSON does not accept `\U`-style escapes, so backslash paths are invalid.
- `primary`: must name one of the declared roots. The primary root's AGENTS.md / CLAUDE.md act as the constraint fallback for roots that have none.
- `options`: optional per-workspace overrides. Only `autoLoadInPrimary` and `promptInOtherDirs` are recognized and both must be booleans.

Validation rejects malformed files with an explanatory error; a corrupt or incompatible file is skipped with a warning while the others load normally. All writes back to definition files are atomic (temp file + rename).

### Options and the resolution chain

Global default option values live in `~/.pi/agent/pi-workspaces.json`:

```json
{
  "defaults": {
    "autoLoadInPrimary": true,
    "promptInOtherDirs": true
  }
}
```

Each option resolves independently, workspace first, then the global defaults file, then the built-in value:

```text
workspace.options.<key>  ??  global defaults.<key>  ??  built-in default
```

Built-in defaults: `autoLoadInPrimary: true`, `promptInOtherDirs: true`.

- `autoLoadInPrimary`: when the session starts inside a workspace's primary root, load that workspace without asking.
- `promptInOtherDirs`: when the session starts anywhere else, offer this workspace in the load prompt.

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

At `session_start` the extension scans both definition sources and then:

1. **Auto-load**: if the session directory equals a workspace's primary root and its `autoLoadInPrimary` resolves true, that workspace loads immediately.
2. **Journal restore**: if the session is a `/resume`, the last recorded active workspace is re-activated.
3. **Ask**: otherwise, if any definition exists and the session has a UI, pi prompts with a select list plus a "Don't load" escape hatch. The list has two layers: when the session directory sits inside some workspace's *non-primary* root, only those containing workspaces are offered; otherwise every workspace whose `promptInOtherDirs` resolves true is offered.

Only one workspace can be active at a time; loading another replaces the current one (with a notification).

## Command reference

All commands are `/workspace` subcommands; output is shown via pi notifications.

| Command | Behavior |
|---------|----------|
| `/workspace` (or `status`) | Show the active workspace: name, origin, primary root, and every root with a `(MISSING)` marker when its directory is gone. |
| `/workspace list` | List all definitions from both sources, each with its `origin` (`global` or `project`) and primary root. |
| `/workspace load <name>` | Activate a workspace by name. |
| `/workspace unload` | Deactivate the active workspace; the statusline clears. |
| `/workspace create <name>` | Create a definition in the **global** source with the current directory as its sole primary root, and activate it. |
| `/workspace add-root [name] <path>` | Add a root to the active workspace. The name is optional (derived from the directory basename when omitted); a relative path anchors at the session directory. The definition is persisted back to its origin source. |
| `/workspace remove-root <name>` | Remove a root from the active workspace and persist. The primary root cannot be removed. |

Interactive argument pickers (for example a fuzzy `load` picker) are post-MVP - missing arguments print usage text instead.

## Headless usage (print / RPC mode)

All commands work headless, which is also how this extension is smoke-tested. Two things to know:

- **Use RPC mode to observe command output.** In print mode (`pi -p`), `ctx.ui.notify` is a no-op, so command output is invisible. In RPC mode (`pi --mode rpc`), every notification and statusline update is emitted as a JSON event: `printf '%s\n' '{"type":"prompt","message":"/workspace list"}' | pi --mode rpc`.
- **Windows / Git Bash argument mangling.** When passing a slash command as an argument (e.g. `pi -p "/workspace list"`), MSYS path conversion rewrites `/workspace` into `C:/Program Files/Git/workspace`. Set `MSYS_NO_PATHCONV=1` (or `MSYS2_ARG_CONV_EXCL="*"`) first.
- **No prompts headless.** The select-list activation step requires a UI; headless sessions rely on auto-load (start pi in the primary root) or journal restore (`-c` / `/resume`). `pi -c` ignores session files that contain no messages.
- **Piped RPC prompts are not serialized.** pi does not await one piped prompt's command handler before starting the next, so mutating commands issued back-to-back in one batch can race on the definition file. Send mutating commands one at a time (interactive use is unaffected).

## How definitions merge

Both sources are scanned at `session_start` and merged **by name**: a project definition overrides a global definition of the same name, and the project source wins per name. A wholesale override never happens - a project file cannot hide your unrelated global workspaces; they keep loading side by side.

- Each merged definition records its `origin` (`global` or `project`), shown by `/workspace list` and `/workspace status`.
- A name collision triggers a one-time-per-session warning: "workspace 'X' from project overrides global".

## Project-level install caveat

A project-level install loads only when the session starts inside that repository. Sessions started in any other directory never load the extension, so auto-load, prompts, tool overrides, and the statusline are all absent there - including sessions that start inside another root of the same workspace. This is expected behavior, not a bug: pi discovers project extensions from the session's own directory. Use a global install if you want the extension everywhere.

## Storage locations

| What | Where |
|------|-------|
| Global definitions | `~/.pi/agent/workspaces/*.json` |
| Project definitions | `<repo>/.pi/workspaces/*.json` |
| Global default options | `~/.pi/agent/pi-workspaces.json` |
| Active-workspace journal | inside the pi session file (custom entry `pi-workspaces:active`) |

## Known limitations

- **Explicit `cwd` drops session env vars.** A `bash` call with an explicit `cwd` runs without the `PI_*` session environment variables (passing the runtime ctx through would override the resolved directory). Calls without `cwd` - the default branch - do inject them.
- **Symlinked definition files are skipped.** The source scan only accepts regular `.json` files, so a workspace definition that is a symbolic link is silently ignored (use a real file or a link to the directory).
- **Symlinked directories complete as files.** Inside a root, the autocomplete provider classifies entries by the directory flag, so a symlinked subdirectory is offered without a trailing `/`.
- **Shared primary path: first match wins.** When two workspace definitions declare the same primary root path, the auto-load scan activates the first one in merged order; there is no ambiguity warning.

## Post-MVP roadmap

Not in this version, planned or desired later:

- `/workspace set-primary` - reassign the primary root of the active workspace.
- `/workspace config` - edit the global default options (`~/.pi/agent/pi-workspaces.json`) from within a session.
- Interactive pickers - create wizard and argument-less `load` picker.
- `fs.watch` hot-reload of definition files (today definitions are read once at `session_start`; use `/workspace load` to re-read).
- Cross-root aggregated search conveniences (one grep across all roots with merged results).
- Internal `samePath` de-duplication refactor (path normalization is currently duplicated between the resolver and the activation check).

## Development

```bash
# Load the extension in development mode from any directory
pi -e /path/to/pi-workspaces/index.ts

# Run tests
node --test "test/**/*.ts"
```

TypeScript loaded directly by pi via jiti - no build step, no third-party runtime dependencies (Node built-ins + pi exports only).
