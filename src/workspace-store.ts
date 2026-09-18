// Workspace store. Part 1 (above): definition-file schema validation,
// dual-source merge by name (project wins), and flat session-config
// resolution - pure functions, zero IO. Part 2 (below): project-source
// discovery by marker ascent, definition scanning and atomic file IO, the
// tolerant global config, root health checks, and root add/remove
// operations. Merge is per-name, never a full override:
// global-only workspaces survive alongside project definitions (core design
// constraint 3).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { pathKey, type WorkspaceInfo } from "./path-resolver.ts";

export interface RootDefinition { name: string; path: string }
export type Activation = "auto" | "prompt";
export interface WorkspaceDefinition {
  name: string;
  version: 1;
  roots: RootDefinition[];
}
/**
 * The plugin config as one flat struct (2026-09-19 spec, D4): resolved per
 * key over builtin < global (<agentDir>/pi-workspaces.json) < project
 * (<projectRoot>/.pi/pi-workspaces.json). Definitions carry no options of
 * their own - activation is a property of the project/directory context,
 * not of an individual root set.
 */
export interface WorkspaceConfig {
  activation: Activation;
  warnOnUnrelatedLoad: boolean;
  projectRootAscend: number;
}
export interface LoadedDef { def: WorkspaceDefinition; origin: "global" | "project" }

/**
 * Install scope, detected from the extension file's own location (index.ts):
 * a global install under <agentDir>/extensions/ scans both definition
 * sources and reads the global defaults config; anything else (a project
 * install under <cwd>/.pi/extensions/, or an explicit -e dev path) is
 * project-scoped and only ever sees the discovered project source (D5) -
 * global config files are neither read nor written.
 */
export type InstallScope = "global" | "project";

// Fallback of last resort for every WorkspaceConfig key. projectRootAscend
// is a global-only knob (chicken-and-egg: it controls how definitions are
// found, so no project-level override can be allowed - 2026-09-19 spec D4)
// and is consumed via DEFAULT_PROJECT_ROOT_ASCEND / the global config only.
export const BUILTIN_DEFAULTS = {
  activation: "auto",
  warnOnUnrelatedLoad: true,
  projectRootAscend: 3,
} as const satisfies WorkspaceConfig;

export const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
/** The complete top-level definition schema: anything else is rejected. */
const ALLOWED_DEFINITION_KEYS = ["name", "version", "roots"] as const;

type ValidationResult =
  | { ok: true; def: WorkspaceDefinition }
  | { ok: false; error: string };

/**
 * Validate an untyped parsed-JSON value as a workspace definition. Returns a
 * normalized copy on success; rejects unknown versions, illegal workspace or
 * root names, duplicate root names, empty root lists, and unknown top-level
 * keys (the schema is name/version/roots only - the removed 'options' and
 * legacy 'primary'/'autoLoadInPrimary' keys all fail the generic check).
 * Stale definitions are migrated by hand (D9, simplified: no dedicated
 * legacy-key detection).
 */
export function validateDefinition(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Workspace definition must be a JSON object" };
  }
  const d = data as Record<string, unknown>;

  for (const key of Object.keys(d)) {
    if (!ALLOWED_DEFINITION_KEYS.includes(key as (typeof ALLOWED_DEFINITION_KEYS)[number])) {
      return { ok: false, error: `Unknown workspace definition key: '${key}'` };
    }
  }

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

  const def: WorkspaceDefinition = { name: d.name, version: 1, roots };
  return { ok: true, def };
}

/**
 * Merge two definition sources per workspace name. Definitions that exist in
 * both sources are reported as collisions and the project copy wins; the
 * losing global copy is returned as `shadowed` so callers can gate collision
 * notices on provable cwd relevance (2026-09-19 spec, D2). Global
 * definitions with no project counterpart survive untouched. Global entries
 * keep their source order, with project-only names appended in project order.
 */
export function mergeByName(
  globalDefs: WorkspaceDefinition[],
  projectDefs: WorkspaceDefinition[],
): { merged: LoadedDef[]; shadowed: LoadedDef[]; collisions: string[] } {
  const merged: LoadedDef[] = globalDefs.map((def) => ({ def, origin: "global" as const }));
  const indexByName = new Map(merged.map((entry, i) => [entry.def.name, i]));
  const shadowed: LoadedDef[] = [];
  const collisions: string[] = [];
  for (const def of projectDefs) {
    const i = indexByName.get(def.name);
    if (i === undefined) {
      indexByName.set(def.name, merged.length);
      merged.push({ def, origin: "project" });
    } else {
      shadowed.push(merged[i]);
      merged[i] = { def, origin: "project" };
      collisions.push(def.name);
    }
  }
  return { merged, shadowed, collisions };
}

/**
 * Resolve the effective session config: the project file wins per key;
 * otherwise the global config; otherwise the builtin defaults. Applied per
 * key, so partial config files only override the keys they set.
 * projectRootAscend deliberately ignores the project level: the ascent cap
 * controls how the project itself is discovered (chicken-and-egg, D4).
 */
export function resolveConfig(
  project: Partial<WorkspaceConfig>,
  global: Partial<WorkspaceConfig>,
): WorkspaceConfig {
  return {
    activation: project.activation ?? global.activation ?? BUILTIN_DEFAULTS.activation,
    warnOnUnrelatedLoad:
      project.warnOnUnrelatedLoad ?? global.warnOnUnrelatedLoad ?? BUILTIN_DEFAULTS.warnOnUnrelatedLoad,
    projectRootAscend: global.projectRootAscend ?? BUILTIN_DEFAULTS.projectRootAscend,
  };
}

// ---------------------------------------------------------------------------
// Part 2: definition-file IO, global config, health checks, root operations
// ---------------------------------------------------------------------------

/** Global definition source: <agentDir>/workspaces (see design doc 3.1). */
export function globalWorkspacesDir(): string {
  return path.join(getAgentDir(), "workspaces");
}

/** Root markers for project discovery (D5): the nearest ancestor directory
 * containing any of these wins, even without a .pi/workspaces subdirectory. */
export const PROJECT_MARKERS = [".pi", ".git", ".agents"] as const;

/** Built-in ascent cap for project discovery (see BUILTIN_DEFAULTS). The
 * global defaults config may override it via projectRootAscend (global
 * scope only - the cap controls how definitions are found, so a
 * project-scoped install cannot be allowed to widen its own search). */
export const DEFAULT_PROJECT_ROOT_ASCEND: number = BUILTIN_DEFAULTS.projectRootAscend;

/**
 * Discover the project directory for definition scanning (D5): walk up from
 * `cwd` at most `ascend` levels and stop at the first directory containing
 * any root marker (.pi/.git/.agents). The nearest marker directory wins even
 * when it has no .pi/workspaces subdirectory (or it is empty) - the project
 * source is then simply empty and contributes no auto-load/prompt candidates
 * (no error, no further ascent into outer projects). Never ascends above the
 * user's home directory. When no ancestor within the cap has a marker, the
 * project dir is the cwd itself.
 */
export function discoverProjectDir(cwd: string, ascend: number = DEFAULT_PROJECT_ROOT_ASCEND): string {
  const start = path.resolve(cwd);
  const home = pathKey(os.homedir());
  let dir = start;
  for (let level = 0; ; level++) {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      return dir;
    }
    if (level >= ascend) break; // cap hit: fall back to the cwd itself
    if (pathKey(dir) === home) break; // never ascend above the home directory
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return start;
}

/** Project definition source: discoverProjectDir(cwd)/.pi/workspaces (D5). */
export function projectWorkspacesDir(cwd: string, ascend?: number): string {
  return path.join(discoverProjectDir(cwd, ascend), ".pi", "workspaces");
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
 * Load the definition sources visible to the given install scope. The
 * project source is discovered by marker ascent (D5): the ascent cap comes
 * from the global defaults config in global scope (chicken-and-egg: the cap
 * controls how definitions are found), while project-scoped installs always
 * use the built-in value. Global scope scans both sources and merges per
 * name (project wins); warnings from both scans are concatenated, and name
 * collisions are reported together with the shadowed (losing) definition so
 * callers can surface them relevance-gated (2026-09-19 spec, D2) instead of
 * broadcasting at startup. Project scope scans only the discovered project
 * source, so collisions are impossible and the global directory is never
 * touched. The returned projectDir is the resolved project source
 * directory, so callers persisting project-origin definitions write back to
 * the directory they were actually loaded from; projectRoot is the
 * discovered project directory (the marker dir) that anchors the project
 * config file.
 */
export function loadAll(
  cwd: string,
  scope: InstallScope,
): {
  merged: LoadedDef[];
  shadowed: LoadedDef[];
  collisions: string[];
  warnings: string[];
  projectDir: string;
  projectRoot: string;
} {
  const ascend =
    scope === "global"
      ? (loadGlobalConfig().projectRootAscend ?? DEFAULT_PROJECT_ROOT_ASCEND)
      : DEFAULT_PROJECT_ROOT_ASCEND;
  const projectRoot = discoverProjectDir(cwd, ascend);
  const projectDir = projectWorkspacesDir(cwd, ascend);
  const projectScan = scanSource(projectDir, "project");
  if (scope === "project") {
    return {
      merged: projectScan.defs.map((def) => ({ def, origin: "project" as const })),
      shadowed: [],
      collisions: [],
      warnings: projectScan.warnings,
      projectDir,
      projectRoot,
    };
  }
  const globalScan = scanSource(globalWorkspacesDir(), "global");
  const { merged, shadowed, collisions } = mergeByName(globalScan.defs, projectScan.defs);
  return {
    merged,
    shadowed,
    collisions,
    warnings: [...globalScan.warnings, ...projectScan.warnings],
    projectDir,
    projectRoot,
  };
}

/** Global config file: <agentDir>/pi-workspaces.json (flat, see D4). */
export function globalConfigFile(): string {
  return path.join(getAgentDir(), "pi-workspaces.json");
}

/** Project config file: <projectRoot>/.pi/pi-workspaces.json (D4). */
export function projectConfigFile(projectDir: string): string {
  return path.join(projectDir, ".pi", "pi-workspaces.json");
}

/**
 * Per-key tolerant parse of one flat config object: a wrong-typed value or
 * unknown key degrades to "that key is unset", a missing/unreadable file to
 * an empty partial. readAscend=false skips projectRootAscend entirely - the
 * ascent cap is a global-only knob (D4).
 */
function parseFlatConfig(file: string, readAscend: boolean): Partial<WorkspaceConfig> {
  const config: Partial<WorkspaceConfig> = {};
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return config;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return config;
  const record = data as Record<string, unknown>;
  if (record.activation === "auto" || record.activation === "prompt") config.activation = record.activation;
  if (typeof record.warnOnUnrelatedLoad === "boolean") config.warnOnUnrelatedLoad = record.warnOnUnrelatedLoad;
  if (readAscend) {
    const ascend = record.projectRootAscend;
    if (typeof ascend === "number" && Number.isInteger(ascend) && ascend >= 0) {
      config.projectRootAscend = ascend;
    }
  }
  return config;
}

/**
 * Load the global config. Tolerant by design: any problem (missing file,
 * corrupt JSON, wrong shape, wrongly typed values, unknown keys) degrades
 * to "that key is unset" and never throws; resolveConfig falls back per
 * key. Read in global scope only.
 */
export function loadGlobalConfig(): Partial<WorkspaceConfig> {
  return parseFlatConfig(globalConfigFile(), true);
}

/**
 * Load the project config (<projectRoot>/.pi/pi-workspaces.json). Same
 * tolerance as loadGlobalConfig. projectRootAscend is not read here: the
 * ascent cap controls how the project itself is discovered, so it is a
 * global-only knob (D4).
 */
export function loadProjectConfig(projectDir: string): Partial<WorkspaceConfig> {
  return parseFlatConfig(projectConfigFile(projectDir), false);
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
 * name that collides with an existing root, or an empty path. The input
 * definition is not mutated.
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
 * Return a copy of `def` with the named root removed. Throws when no such
 * root exists, or when the workspace would be left without roots: the last
 * remaining root is protected (D8, replacing the old primary protection).
 * The input definition is not mutated.
 */
export function removeRoot(def: WorkspaceDefinition, name: string): WorkspaceDefinition {
  if (!def.roots.some((root) => root.name === name)) {
    throw new Error(`Unknown root '${name}' in workspace '${def.name}'`);
  }
  if (def.roots.length === 1) {
    throw new Error(`Cannot remove the last root of workspace '${def.name}'`);
  }
  return { ...def, roots: def.roots.filter((root) => root.name !== name) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
