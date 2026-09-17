// Workspace store, part 1: definition-file schema validation, dual-source
// merge by name (project wins), and the three-level options chain. Pure
// functions, zero IO - definition scanning and file writes live in part 2.
// Merge is per-name, never a full override: global-only workspaces survive
// alongside project definitions (core design constraint 3).
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
