// The /workspace command: one command, seven subcommands -
// (none)/status, list, load, unload, create, add-root, remove-root.
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
import type { WorkspaceInfo } from "./path-resolver.ts";
import {
  addRoot,
  globalWorkspacesDir,
  loadAll,
  NAME_PATTERN,
  projectWorkspacesDir,
  removeRoot,
  saveDefinition,
  toWorkspaceInfo,
  type LoadedDef,
  type RootDefinition,
  type WorkspaceDefinition,
} from "./workspace-store.ts";

/** State the command needs from the extension host (wired in index.ts). */
export interface CommandDeps {
  getActive(): WorkspaceInfo | null;
  setActive(ws: WorkspaceInfo | null, ctx?: any): void;
}

const USAGE = `Usage: /workspace [subcommand]
  (none)                  show active workspace status
  list                    list workspaces from global and project sources
  load <name>             activate a workspace
  unload                  deactivate the active workspace
  create <name>           create a workspace with the current directory as its
                          sole primary root (saved to the global source)
  add-root [name] <path>  add a root to the active workspace
  remove-root <name>      remove a root from the active workspace`;

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
 * the primary root, then every root with its availability marker. Pure
 * except for the fs check on definition roots (the WorkspaceInfo variant
 * carries exists flags already).
 */
export function formatStatus(ws: WorkspaceInfo): string {
  const lines = [
    `workspace '${ws.name}' (origin: ${ws.origin})`,
    `primary: ${ws.primary}`,
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
        `'${def.name}' (origin: ${origin}, primary: ${def.primary})`,
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
    description:
      "Manage multi-root workspaces: status, list, load, unload, create, add-root, remove-root",
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
            return showList(ctx);
          case "load":
            return await loadWorkspace(ctx, deps, rest[0]);
          case "unload":
            return unloadWorkspace(ctx, deps);
          case "create":
            return await createWorkspace(ctx, deps, rest[0]);
          case "add-root":
            return await changeRoots(ctx, deps, rest, "add");
          case "remove-root":
            return await changeRoots(ctx, deps, rest, "remove");
          default:
            return notify(ctx, USAGE, "error");
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

function showList(ctx: ExtensionCommandContext): void {
  const { merged } = loadAll(ctx.cwd);
  notify(ctx, formatList(merged));
}

async function loadWorkspace(ctx: ExtensionCommandContext, deps: CommandDeps, name: string | undefined): Promise<void> {
  if (name === undefined) {
    notify(ctx, USAGE, "error");
    return;
  }
  const { merged } = loadAll(ctx.cwd);
  const entry = merged.find((m) => m.def.name === name);
  if (!entry) {
    notify(ctx, `Workspace '${name}' not found. Run /workspace list to see available workspaces.`, "error");
    return;
  }
  const ws = toWorkspaceInfo(entry.def, entry.origin);
  deps.setActive(ws, ctx);
  notify(ctx, formatStatus(ws));
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
    notify(ctx, USAGE, "error");
    return;
  }
  if (!NAME_PATTERN.test(name)) {
    notify(ctx, `Illegal workspace name: '${name}' (must match ${NAME_PATTERN.source})`, "error");
    return;
  }
  const { merged } = loadAll(ctx.cwd);
  if (merged.some((m) => m.def.name === name)) {
    notify(ctx, `Workspace '${name}' already exists.`, "error");
    return;
  }
  // The current directory becomes the sole primary root; the root name
  // falls back to a safe alphabet so dotted/spaced dir names stay valid.
  const rootName = primaryRootName(ctx.cwd);
  const def: WorkspaceDefinition = {
    name,
    version: 1,
    roots: [{ name: rootName, path: ctx.cwd }],
    primary: rootName,
  };
  await saveDefinition(globalWorkspacesDir(), def);
  const ws = toWorkspaceInfo(def, "global");
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
      notify(ctx, USAGE, "error");
      return;
    }
    name = rest.length === 2 ? rest[0] : null;
    rootPath = rest[rest.length - 1];
  } else {
    if (rest.length !== 1) {
      notify(ctx, USAGE, "error");
      return;
    }
    name = rest[0];
  }

  const active = deps.getActive();
  if (!active) {
    notify(ctx, "No workspace is active; use /workspace load or /workspace create first.", "error");
    return;
  }
  const { merged } = loadAll(ctx.cwd);
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
    // primary removal, unknown root) land here as notifications.
    notify(ctx, errorMessage(err), "error");
    return;
  }

  const dir = entry.origin === "project" ? projectWorkspacesDir(ctx.cwd) : globalWorkspacesDir();
  await saveDefinition(dir, mutated);
  const ws = toWorkspaceInfo(mutated, entry.origin);
  deps.setActive(ws, ctx);
  notify(ctx, formatStatus(ws));
}

/** Derive a valid root name from the cwd basename (dots/spaces -> "-"). */
function primaryRootName(cwd: string): string {
  const cleaned = path
    .basename(cwd)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "primary";
}
