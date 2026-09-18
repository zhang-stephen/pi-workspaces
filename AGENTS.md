# AGENTS.md - pi-workspaces

## Project Overview

pi-workspaces is an extension for the [pi coding agent](https://pi.dev) that adds **multi-root workspace** support: multiple working directories (roots) are merged into one workspace, letting the agent read/write files, run commands, and search code across roots within a single session.

All designs live in [docs/](./docs) - **read them before implementing anything**.

## Style

- ASCII only in code and documentation files

## Tech Stack & Runtime

- **Language**: TypeScript, loaded directly by pi via jiti - **no build step**
- **Entry point**: `index.ts`, default-exporting an `ExtensionFactory`
- **API source**: everything comes from the `@earendil-works/pi-coding-agent` package (`ExtensionAPI`, `createReadTool`, `createBashTool`, `getAgentDir`, etc.)
- **No third-party runtime dependencies** - Node built-ins + pi exports only

## Local Development

```bash
# Load the extension in development mode from any directory
pi -e /path/to/pi-workspaces/index.ts

# Run tests
node --test "test/**/*.ts"
```

## Directory Layout

```
index.ts                 # Extension entry (ExtensionFactory, wiring only)
src/workspace-store.ts   # Workspace definition & plugin config IO (dual-source scan, atomic writes)
src/path-resolver.ts     # @root/ path resolution (pure functions, no IO)
src/tools.ts             # Overrides for the 7 built-in tools
src/commands.ts          # /workspace slash commands
src/prompt-inject.ts     # before_agent_start injection + on-demand constraint-file injection
src/statusline.ts        # Footer status display
src/autocomplete.ts      # Editor @root completion provider
test/                    # node:test tests (pure-function unit tests + temp-dir integration tests)
docs/                    # Design specs and docs (committed)
```

## Core Design Constraints (read before changing anything)

1. **Bare relative paths always resolve against the session start directory** (identical to pi's default semantics - never change this)
2. Only the `@root-name/path` prefix and absolute paths may reach other roots; resolution must prevent `..` escapes outside the target root
3. Workspace definitions are **merged by name, project source wins** (official pi convention, see the preset.ts example) - never switch to full override
4. Paths outside all roots keep pi's default behavior - **no extra permission guardrails**
5. When overriding built-in tools: preserve the result-shape contract, omit render functions to inherit built-in rendering, and explicitly define promptSnippet/promptGuidelines (they are NOT inherited)
6. bash is stateless (a fresh process per call), so specifying cwd per call is safe
7. All storage writes must be atomic (temp file + rename)

## Runtime Storage Locations

- Global definitions: `~/.pi/agent/workspaces/*.json`
- Project-level definitions: `<repo>/.pi/workspaces/*.json`
- Global config: `~/.pi/agent/pi-workspaces.json`
- Project config: `<repo>/.pi/pi-workspaces.json` (overrides the global config per key)
- Session state: `pi.appendEntry()` (inside the session file)

## Commit Conventions

- Conventional Commits with a scope naming the touched component: `feat(commands):`, `fix(tools):`, `test(test):`, `docs:`, English descriptions
- Run `node --test "test/**/*.ts"` before every commit
