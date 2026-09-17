// Workspace path resolution: pure functions, zero IO. Every overridden tool
// uses these to translate "@root-name/path" references into absolute paths.
// Containment is lexical: root paths are canonicalized by the workspace
// store, so comparisons only normalize separators and win32 drive-letter
// case (per the path-resolution design section).
import * as path from "node:path";

export interface RootInfo { name: string; path: string; exists: boolean }
export interface WorkspaceInfo { name: string; roots: RootInfo[]; primary: string; origin: "global" | "project" }
export type ResolveResult =
  | { ok: true; absolutePath: string; root: RootInfo | null }
  | { ok: false; error: string }

/**
 * Comparison key used for containment: separators normalized to "/", a
 * leading win32 drive letter lowercased, and a redundant trailing slash
 * dropped. Everything else is compared verbatim (lexical, case-sensitive).
 */
function comparisonKey(p: string): string {
  let key = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(key)) key = key[0].toLowerCase() + key.slice(1);
  if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

/** Lexical containment: true when `child` equals `parent` or sits beneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = comparisonKey(parent);
  const c = comparisonKey(child);
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : p + "/";
  return c.startsWith(prefix);
}

/** The root owning `absolutePath`: longest matching root path wins (nested roots). */
export function owningRoot(ws: WorkspaceInfo, absolutePath: string): RootInfo | null {
  let best: RootInfo | null = null;
  let bestLen = -1;
  for (const r of ws.roots) {
    if (!isInside(r.path, absolutePath)) continue;
    const len = comparisonKey(r.path).length;
    if (len > bestLen) {
      best = r;
      bestLen = len;
    }
  }
  return best;
}

// "@name" or "@name/rest..."; name runs up to the first separator, rest may
// be empty (meaning the root directory itself).
const ROOT_REF = /^@([^/\\]*)(?:[/\\]+([\s\S]*))?$/;

/**
 * Resolve a tool-call path. Priority: absolute path > "@root-name/..." >
 * bare relative (against the session start directory, never changed).
 */
export function resolveWorkspacePath(input: string, ws: WorkspaceInfo | null, sessionCwd: string): ResolveResult {
  if (path.isAbsolute(input)) {
    const absolutePath = path.normalize(input);
    const root = ws ? owningRoot(ws, absolutePath) : null;
    if (root && !root.exists) {
      return { ok: false, error: unavailableError(root) };
    }
    return { ok: true, absolutePath, root };
  }

  if (input.startsWith("@")) {
    if (!ws) {
      return {
        ok: false,
        error: `No workspace is active; cannot resolve '${input}'. Activate a workspace before using '@root' paths.`,
      };
    }
    const match = ROOT_REF.exec(input);
    const name = match ? match[1] : "";
    const rest = match && match[2] !== undefined ? match[2] : "";
    const root = ws.roots.find((r) => r.name === name);
    if (!root) {
      const names = ws.roots.map((r) => `'${r.name}'`).join(", ") || "(none)";
      return { ok: false, error: `Unknown root '${name}' in '${input}'. Available roots: ${names}` };
    }
    if (!root.exists) {
      return { ok: false, error: unavailableError(root) };
    }
    // Empty path part resolves to the root dir itself; path.join otherwise
    // normalizes the (lexical) remainder, collapsing "." and ".." segments.
    const absolutePath = rest === "" ? root.path : path.join(root.path, rest);
    if (!isInside(root.path, absolutePath)) {
      return {
        ok: false,
        error: `Path '${input}' escapes root '${root.name}'; '@root' paths must stay inside their root (no '..')`,
      };
    }
    return { ok: true, absolutePath, root };
  }

  return { ok: true, absolutePath: path.resolve(sessionCwd, input), root: null };
}

function unavailableError(root: RootInfo): string {
  return `Root '${root.name}' is unavailable (path missing on disk): ${root.path}`;
}
