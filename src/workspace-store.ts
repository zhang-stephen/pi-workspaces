// Workspace store. Part 1 (above): definition-file schema validation,
// dual-source merge by name (project wins), and the three-level options
// chain - pure functions, zero IO. Part 2 (below): definition scanning and
// atomic file IO, the tolerant global config, root health checks, and root
// add/remove operations. Merge is per-name, never a full override:
// global-only workspaces survive alongside project definitions (core design
// constraint 3).
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkspaceInfo } from "./path-resolver.ts";

export interface RootDefinition { name: string; path: string }
export interface WorkspaceOptions { autoLoadInPrimary: boolean; promptInOtherDirs: boolean }
export interface WorkspaceDefinition {
  name: string;
  version: 1;
  roots: RootDefinition[];
  primary: string;
  options?: Partial<WorkspaceOptions>;
}
export interface LoadedDef { def: WorkspaceDefinition; origin: "global" | "project" }

// Fallback of last resort for the options chain (workspace ?? defaults ?? builtin).
export const BUILTIN_DEFAULTS: WorkspaceOptions = {
  autoLoadInPrimary: true,
  promptInOtherDirs: true,
};

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const KNOWN_OPTIONS = ["autoLoadInPrimary", "promptInOtherDirs"] as const;

type ValidationResult =
  | { ok: true; def: WorkspaceDefinition }
  | { ok: false; error: string };

/**
 * Validate an untyped parsed-JSON value as a workspace definition. Returns a
 * normalized copy on success; rejects unknown versions, illegal workspace or
 * root names, duplicate root names, empty root lists, and a primary root
 * that is not among the declared roots.
 */
export function validateDefinition(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Workspace definition must be a JSON object" };
  }
  const d = data as Record<string, unknown>;

  if (d.version !== 1) {
    return {
      ok: false,
      error: `Unsupported workspace definition version: ${JSON.stringify(d.version)} (expected 1)`,
    };
  }

  if (typeof d.name !== "string" || !NAME_PATTERN.test(d.name)) {
    return {
      ok: false,
      error: `Illegal workspace name: ${JSON.stringify(d.name)} (must match ${NAME_PATTERN.source})`,
    };
  }

  if (!Array.isArray(d.roots) || d.roots.length === 0) {
    return { ok: false, error: "Workspace definition must declare a non-empty 'roots' array" };
  }

  const seen = new Set<string>();
  const roots: RootDefinition[] = [];
  for (const [i, entry] of d.roots.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `Root at index ${i} must be a JSON object` };
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || !NAME_PATTERN.test(r.name)) {
      return {
        ok: false,
        error: `Illegal root name at index ${i}: ${JSON.stringify(r.name)} (must match ${NAME_PATTERN.source})`,
      };
    }
    if (seen.has(r.name)) {
      return { ok: false, error: `Duplicate root name: '${r.name}'` };
    }
    seen.add(r.name);
    if (typeof r.path !== "string" || r.path.length === 0) {
      return { ok: false, error: `Root '${r.name}' must declare a non-empty 'path' string` };
    }
    roots.push({ name: r.name, path: r.path });
  }

  if (typeof d.primary !== "string" || !seen.has(d.primary)) {
    const names = [...seen].map((n) => `'${n}'`).join(", ");
    return {
      ok: false,
      error: `Primary root '${String(d.primary)}' is not one of the declared roots: ${names}`,
    };
  }

  let options: Partial<WorkspaceOptions> | undefined;
  if (d.options !== undefined) {
    if (typeof d.options !== "object" || d.options === null || Array.isArray(d.options)) {
      return { ok: false, error: "'options' must be a JSON object mapping option names to booleans" };
    }
    const o = d.options as Record<string, unknown>;
    const parsed: Partial<WorkspaceOptions> = {};
    for (const key of Object.keys(o)) {
      if (!KNOWN_OPTIONS.includes(key as (typeof KNOWN_OPTIONS)[number])) {
        return { ok: false, error: `Unknown workspace option: '${key}'` };
      }
      if (typeof o[key] !== "boolean") {
        return { ok: false, error: `Workspace option '${key}' must be a boolean` };
      }
      parsed[key as (typeof KNOWN_OPTIONS)[number]] = o[key] as boolean;
    }
    options = parsed;
  }

  const def: WorkspaceDefinition = { name: d.name, version: 1, roots, primary: d.primary };
  if (options !== undefined) def.options = options;
  return { ok: true, def };
}

/**
 * Merge two definition sources per workspace name. Definitions that exist in
 * both sources are reported as collisions and the project copy wins; global
 * definitions with no project counterpart survive untouched. Global entries
 * keep their source order, with project-only names appended in project order.
 */
export function mergeByName(
  globalDefs: WorkspaceDefinition[],
  projectDefs: WorkspaceDefinition[],
): { merged: LoadedDef[]; collisions: string[] } {
  const merged: LoadedDef[] = globalDefs.map((def) => ({ def, origin: "global" as const }));
  const indexByName = new Map(merged.map((entry, i) => [entry.def.name, i]));
  const collisions: string[] = [];
  for (const def of projectDefs) {
    const i = indexByName.get(def.name);
    if (i === undefined) {
      indexByName.set(def.name, merged.length);
      merged.push({ def, origin: "project" });
    } else {
      merged[i] = { def, origin: "project" };
      collisions.push(def.name);
    }
  }
  return { merged, collisions };
}

/**
 * Resolve the effective options for a workspace: an option set on the
 * definition wins; otherwise the global defaults config; otherwise the
 * builtin defaults. Applied per key, so a partial workspace options object
 * only overrides the keys it sets.
 */
export function resolveOptions(def: WorkspaceDefinition, defaults: WorkspaceOptions): WorkspaceOptions {
  return {
    autoLoadInPrimary:
      def.options?.autoLoadInPrimary ?? defaults.autoLoadInPrimary ?? BUILTIN_DEFAULTS.autoLoadInPrimary,
    promptInOtherDirs:
      def.options?.promptInOtherDirs ?? defaults.promptInOtherDirs ?? BUILTIN_DEFAULTS.promptInOtherDirs,
  };
}

// ---------------------------------------------------------------------------
// Part 2: definition-file IO, global config, health checks, root operations
// ---------------------------------------------------------------------------

/** Global definition source: <agentDir>/workspaces (see design doc 3.1). */
export function globalWorkspacesDir(): string {
  return path.join(getAgentDir(), "workspaces");
}

/** Project definition source: <cwd>/.pi/workspaces. */
export function projectWorkspacesDir(cwd: string): string {
  return path.join(cwd, ".pi", "workspaces");
}

/**
 * Scan one definition source directory for *.json workspace definitions.
 * Corrupt files (unreadable or unparseable) and invalid ones (schema
 * violations, unknown versions) are skipped with a warning so a single bad
 * file never blocks the rest; a missing source directory is not an error
 * and simply yields no definitions. Entries are processed in sorted name
 * order so results are deterministic regardless of fs ordering.
 */
export function scanSource(
  dir: string,
  origin: "global" | "project",
): { defs: WorkspaceDefinition[]; warnings: string[] } {
  const defs: WorkspaceDefinition[] = [];
  const warnings: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { defs, warnings };
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  for (const name of files) {
    const file = path.join(dir, name);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      warnings.push(`Skipping corrupt workspace file '${file}' (${origin} source): ${errorMessage(err)}`);
      continue;
    }
    const result = validateDefinition(data);
    if (!result.ok) {
      warnings.push(`Skipping invalid workspace file '${file}' (${origin} source): ${result.error}`);
      continue;
    }
    defs.push(result.def);
  }
  return { defs, warnings };
}

/**
 * Load and merge both definition sources for a session: global definitions
 * first, project definitions merged per name on top (project wins).
 * Warnings from both scans are concatenated; name collisions are reported
 * so callers can notify the user that the project copy overrode the global.
 */
export function loadAll(cwd: string): { merged: LoadedDef[]; collisions: string[]; warnings: string[] } {
  const globalScan = scanSource(globalWorkspacesDir(), "global");
  const projectScan = scanSource(projectWorkspacesDir(cwd), "project");
  const { merged, collisions } = mergeByName(globalScan.defs, projectScan.defs);
  return { merged, collisions, warnings: [...globalScan.warnings, ...projectScan.warnings] };
}

/**
 * Load the global default option config (~/.pi/agent/pi-workspaces.json,
 * shape { "defaults": { "autoLoadInPrimary": bool, ... } }). Tolerant by
 * design: any problem (missing file, corrupt JSON, wrong shape, non-boolean
 * values, unknown keys) degrades to "that key is unset" and never throws,
 * leaving the fallback to the caller's options chain. The result may be
 * sparse; resolveOptions falls back per key.
 */
export function loadGlobalConfig(): WorkspaceOptions {
  const config = {} as WorkspaceOptions;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "pi-workspaces.json"), "utf8"));
  } catch {
    return config;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return config;
  const defaults = (data as Record<string, unknown>).defaults;
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return config;
  for (const key of KNOWN_OPTIONS) {
    const value = (defaults as Record<string, unknown>)[key];
    if (typeof value === "boolean") config[key] = value;
  }
  return config;
}

/**
 * Persist a workspace definition as <dir>/<name>.json, atomically: the
 * serialized JSON is written to a sibling .tmp file first and then renamed
 * over the target, so a crash mid-write can never leave a truncated
 * definition behind (readers skip .tmp leftovers, which never match the
 * *.json scan filter). The directory is created on demand.
 */
export async function saveDefinition(dir: string, def: WorkspaceDefinition): Promise<void> {
  const target = path.join(dir, `${def.name}.json`);
  const tmp = `${target}.tmp`;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(tmp, `${JSON.stringify(def, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmp, target);
}

/**
 * Health-check a loaded definition into the runtime shape used by the path
 * resolver: every root path is checked on disk, existing roots are
 * canonicalized with realpath (so containment checks can stay lexical),
 * and missing roots keep their declared path verbatim with exists: false.
 * Never throws for missing roots; a path that exists but cannot be
 * canonicalized (e.g. a broken symlink) is also flagged as unavailable.
 */
export function toWorkspaceInfo(def: WorkspaceDefinition, origin: "global" | "project"): WorkspaceInfo {
  return {
    name: def.name,
    primary: def.primary,
    origin,
    roots: def.roots.map((root) => {
      if (!fs.existsSync(root.path)) {
        return { name: root.name, path: root.path, exists: false };
      }
      try {
        return { name: root.name, path: fs.realpathSync(root.path), exists: true };
      } catch {
        return { name: root.name, path: root.path, exists: false };
      }
    }),
  };
}

/**
 * Return a copy of `def` with one root appended. A null name defaults to the
 * basename of `rootPath`. Throws on an illegal name (see NAME_PATTERN), a
 * name that collides with an existing root, or an empty path. The primary
 * root is left untouched; the input definition is not mutated.
 */
export function addRoot(def: WorkspaceDefinition, name: string | null, rootPath: string): WorkspaceDefinition {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    throw new Error("Root path must be a non-empty string");
  }
  const rootName = name ?? path.basename(rootPath);
  if (!NAME_PATTERN.test(rootName)) {
    throw new Error(`Illegal root name: '${rootName}' (must match ${NAME_PATTERN.source})`);
  }
  if (def.roots.some((root) => root.name === rootName)) {
    throw new Error(`Duplicate root name: '${rootName}'`);
  }
  return { ...def, roots: [...def.roots, { name: rootName, path: rootPath }] };
}

/**
 * Return a copy of `def` with the named root removed. Throws when removing
 * the primary root (forbidden: a workspace must always have one) or when no
 * such root exists. Since the primary can never be removed, the remaining
 * roots are never empty. The input definition is not mutated.
 */
export function removeRoot(def: WorkspaceDefinition, name: string): WorkspaceDefinition {
  if (name === def.primary) {
    throw new Error(`Cannot remove primary root '${name}' of workspace '${def.name}'`);
  }
  if (!def.roots.some((root) => root.name === name)) {
    throw new Error(`Unknown root '${name}' in workspace '${def.name}'`);
  }
  return { ...def, roots: def.roots.filter((root) => root.name !== name) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
