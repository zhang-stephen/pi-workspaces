// The /workspace command: one command, eight subcommands -
// (none)/status, list, load, unload, create, add-root, remove-root, config.
// Output goes through ctx.ui.notify; every failure (bad args, unknown
// workspace, store-level validation errors from addRoot/removeRoot) is
// reported as notify(msg, "error"). Interactive pickers for missing
// arguments are post-MVP: usage text is printed instead.
// Every mutation follows the same durable flow: reload the definition from
// disk via loadAll, mutate the pure way, saveDefinition back to its origin
// directory (atomic tmp+rename), then setActive(toWorkspaceInfo(...)) so
// the runtime shape is rebuilt from what was actually persisted.
// ASCII only - no emoji or symbols.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isInside, type WorkspaceInfo } from "./path-resolver.ts";
import {
  addRoot,
  DEFAULT_PROJECT_ROOT_ASCEND,
  discoverProjectDir,
  globalConfigFile,
  globalWorkspacesDir,
  loadAll,
  loadGlobalConfig,
  loadProjectConfig,
  NAME_PATTERN,
  projectConfigFile,
  removeRoot,
  resolveConfig,
  saveDefinition,
  setConfigKey,
  toWorkspaceInfo,
  unsetConfigKey,
  type InstallScope,
  type LoadedDef,
  type RootDefinition,
  type WorkspaceConfig,
  type WorkspaceDefinition,
} from "./workspace-store.ts";

/** State the command needs from the extension host (wired in index.ts). */
export interface CommandDeps {
  getActive(): WorkspaceInfo | null;
  setActive(ws: WorkspaceInfo | null, ctx?: any): void;
  /** Install scope: decides which definition sources are visible and where create persists. */
  scope: InstallScope;
  /**
   * The session cwd. Needed by argument completion, which pi calls without
   * a command context (getArgumentCompletions receives the argument text
   * only).
   */
  getCwd(): string;
}

/** Argument completion item. Structural - pi's AutocompleteItem comes from
 * pi-tui, which this repo does not depend on. */
interface ArgumentItem {
  value: string;
  label: string;
  description?: string;
}

type ArgKind = "none" | "workspace" | "root" | "create-name" | "add" | "config";

interface SubcommandSpec {
  name: string;
  description: string;
  args: ArgKind;
}

/** The subcommand table drives both dispatch docs and argument completion. */
const SUBCOMMANDS: SubcommandSpec[] = [
  { name: "status", description: "Show the active workspace status", args: "none" },
  { name: "list", description: "List all workspace definitions from the visible sources", args: "none" },
  { name: "load", description: "Activate a workspace by name", args: "workspace" },
  { name: "unload", description: "Deactivate the active workspace", args: "none" },
  { name: "create", description: "Create a workspace with the cwd as its sole root", args: "create-name" },
  { name: "add", description: "Add a root to the active workspace (alias of add-root)", args: "add" },
  { name: "add-root", description: "Add a root to the active workspace: [name] <path>", args: "add" },
  { name: "remove", description: "Remove a root from the active workspace (alias of remove-root)", args: "root" },
  { name: "remove-root", description: "Remove a root from the active workspace", args: "root" },
  { name: "config", description: "Show or change the plugin config (set/unset keys)", args: "config" },
];

/**
 * Argument completion for /workspace. pi calls this with the full text
 * after the command name (e.g. "load de" for "/workspace load de") and the
 * chosen item's value replaces that whole text - so every value rebuilds
 * the complete argument string. The first argument completes subcommand
 * names; arg-taking subcommands get a trailing space so completion
 * continues into their arguments.
 */
function completeWorkspaceArgs(argumentPrefix: string, deps: CommandDeps): ArgumentItem[] | null {
  const spaceIdx = argumentPrefix.search(/\s/);
  if (spaceIdx === -1) {
    const lower = argumentPrefix.toLowerCase();
    const items = SUBCOMMANDS.filter((sub) => sub.name.startsWith(lower)).map((sub) => ({
      value: sub.args === "none" ? sub.name : `${sub.name} `,
      label: sub.name,
      description: sub.description,
    }));
    return items.length > 0 ? items : null;
  }
  const spec = SUBCOMMANDS.find((sub) => sub.name === argumentPrefix.slice(0, spaceIdx).toLowerCase());
  if (!spec) return null;
  const rest = argumentPrefix.slice(spaceIdx + 1);
  return completeSubcommandArg(spec, rest, deps);
}

/** Per-subcommand argument completion. */
function completeSubcommandArg(spec: SubcommandSpec, rest: string, deps: CommandDeps): ArgumentItem[] | null {
  switch (spec.args) {
    case "workspace":
      return completeWorkspaceName(spec, rest, deps);
    case "root":
      return completeRootName(spec, rest, deps);
    case "add":
      return completeAddArgs(spec, rest, deps);
    case "config":
      return completeConfigArgs(spec, rest, deps);
    default:
      return null; // none / create-name: free text or no arguments
  }
}

/**
 * `load` completes workspace names from the merged visible definitions,
 * excluding the currently active one (loading it would be a no-op).
 * Descriptions disambiguate origins: "project" for project definitions,
 * the absolute definition-file path for global ones. Scope isolation (D1):
 * project-scoped installs never see globals here. Exactly one argument -
 * whitespace in `rest` means the argument is already complete.
 */
function completeWorkspaceName(spec: SubcommandSpec, rest: string, deps: CommandDeps): ArgumentItem[] | null {
  if (/\s/.test(rest)) return null;
  const activeName = deps.getActive()?.name;
  const lower = rest.toLowerCase();
  const items = loadAll(deps.getCwd(), deps.scope)
    .merged.filter((m) => m.def.name !== activeName)
    .filter((m) => m.def.name.toLowerCase().startsWith(lower))
    .map((m) => ({
      value: `${spec.name} ${m.def.name}`,
      label: m.def.name,
      description: m.origin === "project" ? "project" : path.join(globalWorkspacesDir(), `${m.def.name}.json`),
    }));
  return items.length > 0 ? items : null;
}

/** `remove` completes the active workspace's root names. */
function completeRootName(spec: SubcommandSpec, rest: string, deps: CommandDeps): ArgumentItem[] | null {
  if (/\s/.test(rest)) return null;
  const ws = deps.getActive();
  if (!ws) return null;
  const lower = rest.toLowerCase();
  const items = ws.roots
    .filter((root) => root.name.toLowerCase().startsWith(lower))
    .map((root) => ({ value: `${spec.name} ${root.name}`, label: root.name, description: root.path }));
  return items.length > 0 ? items : null;
}

/** A token is a path when it contains a separator or a drive letter. */
function looksLikePath(token: string): boolean {
  return token.includes("/") || token.includes("\\") || /^[A-Za-z]:/.test(token);
}

/**
 * The project config path as completion display text. pi calls argument
 * completion without a command context, so the project root is re-discovered
 * from the session cwd exactly the way loadAll does (marker ascent, cap from
 * the global config in global scope).
 */
function projectConfigPathFor(deps: CommandDeps): string {
  const ascend =
    deps.scope === "global"
      ? (loadGlobalConfig().projectRootAscend ?? DEFAULT_PROJECT_ROOT_ASCEND)
      : DEFAULT_PROJECT_ROOT_ASCEND;
  return projectConfigFile(discoverProjectDir(deps.getCwd(), ascend));
}

const MAX_ARG_SUGGESTIONS = 50;

/**
 * `add [name] <path>` completes the path argument against the filesystem.
 * With two or more tokens the last one is the path; a single token is a
 * path only when it looks like one (otherwise it is the free-form name).
 * Relative paths anchor at the session cwd; directories re-trigger with a
 * trailing "/". Values rebuild the full argument text because pi replaces
 * the whole argument prefix with the chosen item's value.
 */
function completeAddArgs(spec: SubcommandSpec, rest: string, deps: CommandDeps): ArgumentItem[] | null {
  const tokens = rest.split(/\s+/);
  let valuePrefix: string;
  let pathPrefix: string;
  if (tokens.length >= 2) {
    valuePrefix = `${spec.name} ${tokens.slice(0, -1).join(" ")} `;
    pathPrefix = tokens[tokens.length - 1];
  } else if (looksLikePath(rest)) {
    valuePrefix = `${spec.name} `;
    pathPrefix = rest;
  } else {
    return null; // completing the optional name - free text
  }
  return completeFsPath(valuePrefix, pathPrefix, deps.getCwd());
}

/** Filesystem entries matching the fragment after the last separator. */
function completeFsPath(valuePrefix: string, pathPrefix: string, cwd: string): ArgumentItem[] | null {
  const sepIdx = Math.max(pathPrefix.lastIndexOf("/"), pathPrefix.lastIndexOf("\\"));
  const dirPart = sepIdx === -1 ? "" : pathPrefix.slice(0, sepIdx);
  const fragment = sepIdx === -1 ? pathPrefix : pathPrefix.slice(sepIdx + 1);
  const baseDir = path.isAbsolute(pathPrefix)
    ? dirPart === "" || /^[A-Za-z]:$/.test(dirPart)
      ? path.parse(pathPrefix).root
      : dirPart
    : path.resolve(cwd, dirPart === "" ? "." : dirPart);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const typedDir = sepIdx === -1 ? "" : pathPrefix.slice(0, sepIdx + 1);
  const lower = fragment.toLowerCase();
  const items = entries
    .filter((entry) => entry.name.toLowerCase().startsWith(lower))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_ARG_SUGGESTIONS)
    .map((entry) => ({
      value: `${valuePrefix}${typedDir}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      label: entry.isDirectory() ? `${entry.name}/` : entry.name,
    }));
  return items.length > 0 ? items : null;
}

function usage(scope: InstallScope): string {
  return `Usage: /workspace [subcommand]
  (none)                  show active workspace status
  list                    list workspaces from global and project sources
  load <name>             activate a workspace
  unload                  deactivate the active workspace
  create <name>           create a workspace with the current directory as its
                          sole root (saved to the ${scope} source)
  add [name] <path>       add a root to the active workspace (alias: add-root)
  remove <name>           remove a root from the active workspace (alias: remove-root)
  config                  show the effective config and where each key comes from
  config set <key> <value> [global|project]
                          set a config key (default level: global; keys:
                          activation, warnOnUnrelatedLoad, projectRootAscend)
  config unset <key> [global|project]
                          remove a config key override; falls back to the next
                          level of the resolution chain`;
}

/**
 * One root line shared by the format helpers: two-space indented
 * "name: path", suffixed with " (MISSING)" when the root is unavailable
 * on disk.
 */
function formatRootLine(name: string, rootPath: string, exists: boolean): string {
  return `  ${name}: ${rootPath}${exists ? "" : " (MISSING)"}`;
}

/**
 * Multi-line status block for one workspace: header with name and origin,
 * then every root with its availability marker. Pure except for the fs
 * check on definition roots (the WorkspaceInfo variant carries exists
 * flags already).
 */
export function formatStatus(ws: WorkspaceInfo): string {
  const lines = [
    `workspace '${ws.name}' (origin: ${ws.origin})`,
    ...ws.roots.map((r) => formatRootLine(r.name, r.path, r.exists)),
  ];
  return lines.join("\n");
}

/**
 * Multi-line listing of every loaded definition (both sources, project
 * winning per name). Definition roots carry no health flags, so existence
 * is checked here; the merged order from loadAll is preserved. An empty
 * merged list renders a plain sentence.
 */
export function formatList(merged: LoadedDef[]): string {
  if (merged.length === 0) return "No workspaces defined.";
  return merged
    .map(({ def, origin }) =>
      [
        `'${def.name}' (origin: ${origin})`,
        ...def.roots.map((r) => formatRootLine(r.name, r.path, rootExists(r))),
      ].join("\n"),
    )
    .join("\n");
}

function rootExists(root: RootDefinition): boolean {
  try {
    fs.accessSync(root.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `config` completes its argument chain: set/unset, then the key name, then
 * (for set) the value when the key has a known value set, then the optional
 * level token - filtered per install scope and per key (projectRootAscend is
 * global-only; project-scoped installs never complete or accept 'global').
 */
function completeConfigArgs(spec: SubcommandSpec, rest: string, deps: CommandDeps): ArgumentItem[] | null {
  const tokens = rest.split(/\s+/);
  const valuePrefix = (fixed: string[]): string => `${spec.name} ${fixed.join(" ")} `;
  if (tokens.length === 1) {
    // Completing the operation: set / unset.
    const lower = tokens[0].toLowerCase();
    const items = [
      { name: "set", description: "Set a config key (default level: global)" },
      { name: "unset", description: "Remove a config key override" },
    ]
      .filter((op) => op.name.startsWith(lower))
      .map((op) => ({ value: `${spec.name} ${op.name} `, label: op.name, description: op.description }));
    return items.length > 0 ? items : null;
  }
  const op = tokens[0].toLowerCase();
  if (op !== "set" && op !== "unset") return null;
  const fixed = tokens.slice(1, -1);
  const prefix = tokens[tokens.length - 1].toLowerCase();
  if (fixed.length === 0) {
    // Completing the key name.
    const items = CONFIG_KEY_SPECS.filter((k) => k.key.startsWith(prefix)).map((k) => ({
      value: `${spec.name} ${op} ${k.key} `,
      label: k.key,
      description: k.expected,
    }));
    return items.length > 0 ? items : null;
  }
  const key = fixed[0];
  const keySpec = CONFIG_KEY_SPECS.find((k) => k.key === key);
  if (!keySpec) return null;
  if (op === "set" && fixed.length === 1) {
    // Completing the value: suggest it only when the key has a known value set.
    if (!keySpec.values) return null;
    const items = keySpec.values
      .filter((v) => v.startsWith(prefix))
      .map((v) => ({ value: `${spec.name} set ${key} ${v}`, label: v }));
    return items.length > 0 ? items : null;
  }
  // Completing the optional level token.
  if ((op === "set" && fixed.length === 2) || (op === "unset" && fixed.length === 1)) {
    const levels: { level: ConfigLevel; description: string }[] = [];
    if (deps.scope === "global") {
      levels.push({ level: "global", description: globalConfigFile() });
    }
    if (!keySpec.globalOnly) {
      levels.push({ level: "project", description: projectConfigPathFor(deps) });
    }
    const items = levels
      .filter((l) => l.level.startsWith(prefix))
      .map((l) => ({ value: `${spec.name} ${op} ${fixed.join(" ")} ${l.level}`, label: l.level, description: l.description }));
    return items.length > 0 ? items : null;
  }
  return null;
}

function notify(ctx: ExtensionCommandContext, msg: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(msg, level);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register the single /workspace command on the extension API. `pi` is
 * typed loosely (mirrors the other register* modules) so tests can pass a
 * capturing stub; only registerCommand is used.
 */
export function registerWorkspaceCommands(pi: any, deps: CommandDeps): void {
  pi.registerCommand("workspace", {
    // No in-description attribution (16.2): the palette's source tag shows
    // [u:npm:pi-workspaces] once published; directory installs show only a
    // bare scope letter either way.
    description:
      "Manage multi-root workspaces (status, list, load, unload, create, add, remove, config)",
    getArgumentCompletions: (argumentPrefix: string) => completeWorkspaceArgs(argumentPrefix, deps),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const tokens = args
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      const sub = tokens[0] ?? "";
      const rest = tokens.slice(1);
      try {
        switch (sub) {
          case "":
          case "status":
            return showStatus(ctx, deps);
          case "list":
            return showList(ctx, deps);
          case "config":
            return await configCommand(ctx, deps, rest);
          case "load":
            return await loadWorkspace(ctx, deps, rest[0]);
          case "unload":
            return unloadWorkspace(ctx, deps);
          case "create":
            return await createWorkspace(ctx, deps, rest[0]);
          case "add-root":
          case "add":
            return await changeRoots(ctx, deps, rest, "add");
          case "remove-root":
          case "remove":
            return await changeRoots(ctx, deps, rest, "remove");
          default:
            return notify(ctx, usage(deps.scope), "error");
        }
      } catch (err) {
        // Last-resort guard: store-level throws surface as notifications.
        notify(ctx, errorMessage(err), "error");
      }
    },
  });
}

function showStatus(ctx: ExtensionCommandContext, deps: CommandDeps): void {
  const active = deps.getActive();
  if (!active) {
    notify(ctx, "No workspace is active.", "error");
    return;
  }
  notify(ctx, formatStatus(active));
}

function showList(ctx: ExtensionCommandContext, deps: CommandDeps): void {
  const { merged } = loadAll(ctx.cwd, deps.scope);
  notify(ctx, formatList(merged));
}

async function loadWorkspace(ctx: ExtensionCommandContext, deps: CommandDeps, name: string | undefined): Promise<void> {
  if (name === undefined) {
    notify(ctx, usage(deps.scope), "error");
    return;
  }
  const { merged, collisions, projectRoot } = loadAll(ctx.cwd, deps.scope);
  const entry = merged.find((m) => m.def.name === name);
  if (!entry) {
    notify(ctx, `Workspace '${name}' not found. Run /workspace list to see available workspaces.`, "error");
    return;
  }
  const ws = toWorkspaceInfo(entry.def, entry.origin);
  deps.setActive(ws, ctx);
  // D7: loading a workspace whose roots do not contain the cwd proceeds,
  // but warns - bare relative paths stay anchored at the session directory.
  // The global config file is only readable in global scope (D1).
  const config = resolveConfig(loadProjectConfig(projectRoot), deps.scope === "global" ? loadGlobalConfig() : {});
  if (
    config.warnOnUnrelatedLoad &&
    !ws.roots.some((r) => isInside(r.path, ctx.cwd))
  ) {
    notify(
      ctx,
      `Warning: the session directory is not inside any root of '${ws.name}'; ` +
        `bare relative paths stay anchored at the session directory (${ctx.cwd}).`,
      "warning",
    );
  }
  notify(ctx, formatStatus(ws));
  // Collision relevance (2026-09-19 spec, D2 Case A): the info line
  // accompanies only the activation of a collided workspace - the project
  // copy just loaded is the winner, the global copy is ignored.
  if (collisions.includes(name)) {
    notify(ctx, `Workspace '${name}' is also defined in the global source; the project definition wins.`, "info");
  }
}

function unloadWorkspace(ctx: ExtensionCommandContext, deps: CommandDeps): void {
  const active = deps.getActive();
  if (!active) {
    notify(ctx, "No workspace is active.", "error");
    return;
  }
  // Session journaling is setActive's concern (pi-workspaces:active
  // entries, landed in index.ts); the command only deactivates.
  deps.setActive(null, ctx);
  notify(ctx, `Workspace '${active.name}' unloaded.`);
}

async function createWorkspace(ctx: ExtensionCommandContext, deps: CommandDeps, name: string | undefined): Promise<void> {
  if (name === undefined) {
    notify(ctx, usage(deps.scope), "error");
    return;
  }
  if (!NAME_PATTERN.test(name)) {
    notify(ctx, `Illegal workspace name: '${name}' (must match ${NAME_PATTERN.source})`, "error");
    return;
  }
  const { merged, projectDir } = loadAll(ctx.cwd, deps.scope);
  if (merged.some((m) => m.def.name === name)) {
    notify(ctx, `Workspace '${name}' already exists.`, "error");
    return;
  }
  // The current directory becomes the sole root; the root name falls back
  // to a safe alphabet so dotted/spaced dir names stay valid.
  const rootName = rootNameFromCwd(ctx.cwd);
  const def: WorkspaceDefinition = {
    name,
    version: 1,
    roots: [{ name: rootName, path: ctx.cwd }],
  };
  // The definition lands in the source matching the install scope: a
  // global install persists globally, anything else (project install or
  // -e dev load) stays inside the discovered project source and never
  // touches the global config directory.
  const origin = deps.scope;
  const dir = origin === "project" ? projectDir : globalWorkspacesDir();
  await saveDefinition(dir, def);
  const ws = toWorkspaceInfo(def, origin);
  deps.setActive(ws, ctx);
  notify(ctx, formatStatus(ws));
}

/**
 * Shared reload-mutate-persist-activate flow for add-root/remove-root.
 * The active workspace is required; its definition is reloaded from disk
 * (never taken from the possibly stale active snapshot), mutated, saved
 * back to the origin directory it was loaded from, and the active runtime
 * shape is rebuilt from the persisted definition.
 */
async function changeRoots(
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
  rest: string[],
  op: "add" | "remove",
): Promise<void> {
  let name: string | null;
  let rootPath: string | undefined;
  if (op === "add") {
    if (rest.length < 1 || rest.length > 2) {
      notify(ctx, usage(deps.scope), "error");
      return;
    }
    name = rest.length === 2 ? rest[0] : null;
    rootPath = rest[rest.length - 1];
  } else {
    if (rest.length !== 1) {
      notify(ctx, usage(deps.scope), "error");
      return;
    }
    name = rest[0];
  }

  const active = deps.getActive();
  if (!active) {
    notify(ctx, "No workspace is active; use /workspace load or /workspace create first.", "error");
    return;
  }
  const { merged, projectDir } = loadAll(ctx.cwd, deps.scope);
  const entry = merged.find((m) => m.def.name === active.name);
  if (!entry) {
    notify(ctx, `Definition for active workspace '${active.name}' not found on disk; cannot persist changes.`, "error");
    return;
  }

  let mutated: WorkspaceDefinition;
  try {
    if (op === "add") {
      // Relative root paths anchor at the session cwd so later health
      // checks see absolute paths.
      const resolved = path.isAbsolute(rootPath as string) ? (rootPath as string) : path.resolve(ctx.cwd, rootPath as string);
      mutated = addRoot(entry.def, name, resolved);
    } else {
      mutated = removeRoot(entry.def, name as string);
    }
  } catch (err) {
    // addRoot/removeRoot validation errors (duplicate/illegal name,
    // last-root protection, unknown root) land here as notifications.
    notify(ctx, errorMessage(err), "error");
    return;
  }

  const dir = entry.origin === "project" ? projectDir : globalWorkspacesDir();
  await saveDefinition(dir, mutated);
  const ws = toWorkspaceInfo(mutated, entry.origin);
  deps.setActive(ws, ctx);
  notify(ctx, formatStatus(ws));
}

// -------------------------------------------------------------------------
// /workspace config: show and mutate the flat plugin config (D4)
// -------------------------------------------------------------------------

type ConfigLevel = "global" | "project";

interface ConfigKeySpec {
  key: string;
  /** Known value set, completed and displayed; null = free-form (integer). */
  values: string[] | null;
  /** Human-readable expected format, shown on invalid values and completion. */
  expected: string;
  /** projectRootAscend is global-only: the ascent cap controls how the
   * project itself is discovered, so no project-level override exists (D4). */
  globalOnly: boolean;
  parse(raw: string): unknown;
  /** Effect-timing note appended to set/unset confirmations. */
  effect: string;
}

const CONFIG_KEY_SPECS: ConfigKeySpec[] = [
  {
    key: "activation",
    values: ["auto", "prompt"],
    expected: "'auto' or 'prompt'",
    globalOnly: false,
    parse: (raw) => raw,
    effect: "Applies to new sessions (activation is resolved at session start).",
  },
  {
    key: "warnOnUnrelatedLoad",
    values: ["true", "false"],
    expected: "'true' or 'false'",
    globalOnly: false,
    parse: (raw) => raw === "true",
    effect: "Applies from the next /workspace load.",
  },
  {
    key: "projectRootAscend",
    values: null,
    expected: "a non-negative integer (global-only key)",
    globalOnly: true,
    parse: (raw) => Number(raw),
    effect: "Applies from the next workspace source scan (list/load/create).",
  },
];

function findKeySpec(key: string): ConfigKeySpec | undefined {
  return CONFIG_KEY_SPECS.find((spec) => spec.key === key);
}

/**
 * Validate a raw value string against a key spec. Returns the typed JSON
 * value to persist, or an error message when the value is malformed.
 */
function parseConfigValue(spec: ConfigKeySpec, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (spec.values) {
    if (spec.values.includes(raw)) return { ok: true, value: spec.parse(raw) };
    return { ok: false, error: `Invalid value for '${spec.key}': expected ${spec.expected}.` };
  }
  if (/^\d+$/.test(raw)) return { ok: true, value: spec.parse(raw) };
  return { ok: false, error: `Invalid value for '${spec.key}': expected ${spec.expected}.` };
}

/**
 * Decide which file a set/unset targets. The trailing level token defaults
 * to 'global' in global scope (the plugin config is primarily the user's
 * personal defaults) and to 'project' in project scope (the only file that
 * scope may ever touch). Rejections: an unknown token, the 'global' level
 * under a project-scoped install, and any project-level write to a
 * global-only key.
 */
function resolveConfigLevel(
  deps: CommandDeps,
  spec: ConfigKeySpec,
  token: string | undefined,
): { ok: true; level: ConfigLevel } | { ok: false; error: string } {
  const level = token ?? (deps.scope === "global" ? "global" : "project");
  if (level !== "global" && level !== "project") {
    return { ok: false, error: `Unknown config level '${token}' (use 'global' or 'project').` };
  }
  if (level === "global" && deps.scope !== "global") {
    return {
      ok: false,
      error: "Project-scoped installs never read or write the global config; omit the level or use 'project'.",
    };
  }
  if (level === "project" && spec.globalOnly) {
    return {
      ok: false,
      error: `'${spec.key}' is a global-only key: the ascent cap controls how the project itself is discovered, so it has no project-level override.`,
    };
  }
  return { ok: true, level };
}

function levelFile(level: ConfigLevel, projectRoot: string): string {
  return level === "global" ? globalConfigFile() : projectConfigFile(projectRoot);
}

/** The visible global partial for provenance display: empty in project scope. */
function visibleGlobalConfig(deps: CommandDeps): Partial<WorkspaceConfig> {
  return deps.scope === "global" ? loadGlobalConfig() : {};
}

/**
 * One aligned config row: key, effective value, and provenance - which level
 * of the resolution chain currently supplies the value. In project scope the
 * global level is invisible, so rows resolve to project or builtin only, and
 * the global-only ascend key is labeled as such.
 */
export function formatConfigRow(
  deps: CommandDeps,
  resolved: WorkspaceConfig,
  project: Partial<WorkspaceConfig>,
  global: Partial<WorkspaceConfig>,
  key: string,
): string {
  const spec = findKeySpec(key);
  const k = key as keyof WorkspaceConfig;
  let source: string;
  if (project[k] !== undefined) {
    source = `project (${projectConfigFile(discoverProjectDirFrom(deps))})`;
  } else if (global[k] !== undefined) {
    source = `global (${globalConfigFile()})`;
  } else {
    source = spec?.globalOnly && deps.scope !== "global" ? "builtin default (global-only key)" : "builtin default";
  }
  return `  ${key.padEnd(20)}${String(resolved[k]).padEnd(8)}${source}`;
}

function discoverProjectDirFrom(deps: CommandDeps): string {
  const ascend =
    deps.scope === "global"
      ? (loadGlobalConfig().projectRootAscend ?? DEFAULT_PROJECT_ROOT_ASCEND)
      : DEFAULT_PROJECT_ROOT_ASCEND;
  return discoverProjectDir(deps.getCwd(), ascend);
}

/**
 * The /workspace config dispatcher: bare shows the effective config with
 * provenance; `set <key> <value> [level]` and `unset <key> [level]` mutate
 * exactly one key of one level's file (all other keys preserved). Any other
 * first token prints the usage.
 */
async function configCommand(ctx: ExtensionCommandContext, deps: CommandDeps, rest: string[]): Promise<void> {
  const op = rest[0];
  if (op === undefined) {
    notify(ctx, formatConfig(deps));
    return;
  }
  if (op === "set" || op === "unset") {
    return await changeConfig(ctx, deps, op, rest.slice(1));
  }
  notify(ctx, `Unknown config operation '${op}'.\n\n${configUsage()}`, "error");
}

function configUsage(): string {
  return `Usage: /workspace config
       /workspace config set <key> <value> [global|project]
       /workspace config unset <key> [global|project]
Keys: ${CONFIG_KEY_SPECS.map((k) => k.key).join(", ")}`;
}

/** Bare `config`: effective values plus provenance, via the standard chain. */
function formatConfig(deps: CommandDeps): string {
  const projectRoot = discoverProjectDirFrom(deps);
  const project = loadProjectConfig(projectRoot);
  const global = visibleGlobalConfig(deps);
  const resolved = resolveConfig(project, global);
  const rows = CONFIG_KEY_SPECS.map((spec) => formatConfigRow(deps, resolved, project, global, spec.key));
  return ["Effective config (project > global > builtin default):", ...rows].join("\n");
}

/**
 * `config set` / `config unset`: validate key, value (set only) and level,
 * then persist exactly one key to exactly one file and report the outcome -
 * including the effect-timing note and, for unset, the value the resolution
 * chain now falls back to.
 */
async function changeConfig(ctx: ExtensionCommandContext, deps: CommandDeps, op: "set" | "unset", rest: string[]): Promise<void> {
  const expectedArgs = op === "set" ? "<key> <value> [global|project]" : "<key> [global|project]";
  if (rest.length < (op === "set" ? 2 : 1) || rest.length > (op === "set" ? 3 : 2)) {
    notify(ctx, `Usage: /workspace config ${op} ${expectedArgs}`, "error");
    return;
  }
  const key = rest[0];
  const spec = findKeySpec(key);
  if (!spec) {
    notify(ctx, `Unknown config key '${key}'. Valid keys: ${CONFIG_KEY_SPECS.map((k) => k.key).join(", ")}.`, "error");
    return;
  }
  if (op === "set") {
    const parsed = parseConfigValue(spec, rest[1]);
    if (!parsed.ok) {
      notify(ctx, parsed.error, "error");
      return;
    }
    const level = resolveConfigLevel(deps, spec, rest[2]);
    if (!level.ok) {
      notify(ctx, level.error, "error");
      return;
    }
    const file = levelFile(level.level, discoverProjectDirFrom(deps));
    await setConfigKey(file, key, parsed.value);
    notify(ctx, `Set ${key} = ${JSON.stringify(parsed.value)} in the ${level.level} config (${file}).\n${spec.effect}`);
    return;
  }
  const level = resolveConfigLevel(deps, spec, rest[1]);
  if (!level.ok) {
    notify(ctx, level.error, "error");
    return;
  }
  const file = levelFile(level.level, discoverProjectDirFrom(deps));
  await unsetConfigKey(file, key);
  const projectRoot = discoverProjectDirFrom(deps);
  const resolved = resolveConfig(loadProjectConfig(projectRoot), visibleGlobalConfig(deps));
  notify(
    ctx,
    `Removed '${key}' from the ${level.level} config (${file}).\nEffective value is now ${JSON.stringify(resolved[key as keyof WorkspaceConfig])} (project > global > builtin).`,
  );
}

/** Derive a valid root name from the cwd basename (dots/spaces -> "-"). */
function rootNameFromCwd(cwd: string): string {
  const cleaned = path
    .basename(cwd)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "root";
}
