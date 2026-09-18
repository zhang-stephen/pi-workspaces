// Extension entry (wiring only): assembles the seven tool overrides, the
// /workspace command, the before_agent_start workspace section, the
// first-touch constraint injection, the footer statusline and (on UI
// sessions) the @root autocomplete provider, and drives session activation
// per design section 4:
//   session_start -> loadAll (sources depend on the install scope:
//   global installs see global+project, anything else sees the project
//   source only; the project source is discovered by marker ascent, D5)
//   -> notify warnings/collisions -> auto-load when exactly one workspace
//   contains the session cwd and its activation resolves "auto" ->
//   journal restore (session resume) -> select prompt when ctx.hasUI and
//   at least one workspace contains the cwd (covers activation "prompt"
//   and multi-match disambiguation). A cwd outside every root never
//   prompts (D2).
// setActive is the single activation point: it owns the first-touch
// tracker reset, the statusline refresh and the pi-workspaces:active
// journal entry - nothing else writes the journal.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAutocompleteProvider } from "./src/autocomplete.ts";
import { registerWorkspaceCommands } from "./src/commands.ts";
import { isInside, type WorkspaceInfo } from "./src/path-resolver.ts";
import { buildWorkspacePromptSection, FirstTouchTracker, makeConstraintReader } from "./src/prompt-inject.ts";
import { refreshStatus } from "./src/statusline.ts";
import { registerToolOverrides } from "./src/tools.ts";
import {
  loadAll,
  loadGlobalConfig,
  resolveOptions,
  toWorkspaceInfo,
  type InstallScope,
  type WorkspaceOptions,
} from "./src/workspace-store.ts";

/** Journal entry type: the active workspace name, recorded on every switch. */
const JOURNAL_TYPE = "pi-workspaces:active";

/**
 * Decide which definition sources this install may see from the extension
 * file's own location. A global install (<agentDir>/extensions/) scans both
 * sources and reads the global defaults config. Anything else - a project
 * install under <cwd>/.pi/extensions/ or an explicit -e dev path - is
 * project-scoped: only <cwd>/.pi/workspaces is visible and the global
 * config files are never read or written. Detection failure defaults to
 * the safe project scope.
 */
function detectInstallScope(): InstallScope {
  try {
    const self = fileURLToPath(import.meta.url);
    return isInside(path.join(getAgentDir(), "extensions"), self) ? "global" : "project";
  } catch {
    return "project";
  }
}

/**
 * Scan the current session's entries for the last pi-workspaces:active
 * journal entry and return its recorded workspace name. The session is
 * append-only, so the last matching entry is the most recent activation
 * state. Returns undefined when the ctx has no session manager so callers
 * can tell "no journal" apart from a journaled unload (null), which
 * restores nothing.
 */
function journaledActiveName(ctx: {
  sessionManager?: { getEntries: () => unknown[] };
}): string | null | undefined {
  // getEntries is a class method on pi's SessionManager - call it on the
  // manager itself, because caching the bare reference detaches `this` and
  // crashes on this.fileEntries.
  const sm = ctx.sessionManager;
  if (!sm || typeof sm.getEntries !== "function") return undefined;
  let name: string | null | undefined;
  for (const raw of sm.getEntries()) {
    const entry = raw as { type?: string; customType?: string; data?: unknown } | null | undefined;
    if (entry?.type === "custom" && entry.customType === JOURNAL_TYPE) {
      const data = entry.data as { name?: unknown } | null | undefined;
      name = typeof data?.name === "string" ? data.name : null;
    }
  }
  return name;
}

export default function piWorkspaces(pi: ExtensionAPI, scope: InstallScope = detectInstallScope()): void {
  // Runtime state. Tools and prompt rendering read both through getters so
  // they always observe the current values; sessionCwd is refreshed from
  // ctx.cwd on every session_start (never a captured value).
  let active: WorkspaceInfo | null = null;
  let sessionCwd = "";

  const tracker = new FirstTouchTracker(makeConstraintReader(() => active, () => sessionCwd));
  const getActive = (): WorkspaceInfo | null => active;
  const getSessionCwd = (): string => sessionCwd;

  /**
   * The single activation point. Owns every side effect of a workspace
   * switch: reset the once-per-root constraint tracker, refresh the footer
   * status (when a session ctx is available) and journal the new state so
   * /resume can restore it (design section 4, step 4). Unload journals
   * { name: null }. 16.5: the journal write is skipped when the last
   * journaled entry already records the same state, so reload-safe
   * re-activation does not duplicate entries.
   */
  const setActive = (ws: WorkspaceInfo | null, ctx?: { sessionManager?: { getEntries: () => unknown[] } }): void => {
    active = ws;
    tracker.reset();
    if (ctx) refreshStatus(ctx, ws);
    const name = ws?.name ?? null;
    if (!ctx || journaledActiveName(ctx) !== name) {
      pi.appendEntry(JOURNAL_TYPE, { name });
    }
  };

  registerToolOverrides(pi, {
    getActive,
    sessionCwd: getSessionCwd,
    onFirstTouch: (root, touchedPath) => tracker.onTouch(root, touchedPath),
  });
  registerWorkspaceCommands(pi, { getActive, setActive, scope, getCwd: getSessionCwd });

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;

    // @root editor completion stacks on the built-in provider; only
    // dialog-capable sessions have an editor to complete in. The session
    // cwd pins the "current root" for implicit (root-less) completion.
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider(createAutocompleteProvider(getActive, ctx.cwd));
    }

    const { merged, collisions, warnings } = loadAll(ctx.cwd, scope);
    // Global defaults flow through resolveOptions per definition; the
    // sparse config object itself is never read key-by-key. The global
    // defaults config belongs to the global scope - a project-scoped
    // install resolves options against the built-in defaults only.
    const globalDefaults = scope === "global" ? loadGlobalConfig().options : ({} as Partial<WorkspaceOptions>);
    for (const warning of warnings) {
      ctx.ui.notify(warning, "warning");
    }
    for (const name of collisions) {
      ctx.ui.notify(
        `Workspace '${name}' is defined in both the global and project sources; the project definition wins.`,
        "warning",
      );
    }

    // The containing set (D4): definitions where the session cwd sits
    // inside any root. A cwd outside every root activates nothing and is
    // never prompted (D2).
    const containing = merged.filter(({ def }) => def.roots.some((r) => isInside(r.path, ctx.cwd)));

    // 1. Auto-load: exactly one containing workspace whose activation
    //    resolves "auto". Multiple containing workspaces always prompt
    //    (disambiguation), even when all of them say "auto".
    if (containing.length === 1 && resolveOptions(containing[0].def, globalDefaults).activation === "auto") {
      const { def, origin } = containing[0];
      const ws = toWorkspaceInfo(def, origin);
      setActive(ws, ctx);
      ctx.ui.notify(`Workspace '${ws.name}' auto-loaded (session directory is inside its roots).`);
      return;
    }

    // 2. Session restore: the journal entry written by setActive is the
    //    resume signal. ReadonlySessionManager exposes getEntries(), so
    //    the last pi-workspaces:active entry of the current session
    //    re-activates its workspace when no auto-load fired. The last
    //    entry wins; a journaled null (unload) restores nothing. A fresh
    //    session has no entries, so plain startups never restore.
    const journaled = journaledActiveName(ctx);
    if (typeof journaled === "string") {
      const entry = merged.find((m) => m.def.name === journaled);
      if (entry) {
        const ws = toWorkspaceInfo(entry.def, entry.origin);
        setActive(ws, ctx);
        ctx.ui.notify(`Workspace '${ws.name}' restored from this session's journal.`);
        return;
      }
    }

    // 3. Ask, but only when the cwd sits inside at least one workspace's
    //    roots: offer exactly the containing workspaces. This covers
    //    activation "prompt" workspaces and multi-match disambiguation.
    //    "Don't load" stays as the escape hatch.
    if (containing.length > 0 && ctx.hasUI) {
      const names = containing.map((c) => c.def.name);
      const choice = await ctx.ui.select("Load a workspace for this session?", [...names, "Don't load"]);
      if (choice !== undefined && choice !== "Don't load") {
        const entry = containing.find((c) => c.def.name === choice);
        if (entry) {
          const ws = toWorkspaceInfo(entry.def, entry.origin);
          setActive(ws, ctx);
          ctx.ui.notify(`Workspace '${ws.name}' loaded.`);
          return;
        }
      }
    }

    // Nothing active: clear any stale statusline entry (e.g. after a reload).
    if (!active) {
      refreshStatus(ctx, null);
    }
  });

  pi.on("before_agent_start", (event) => {
    // The workspace section is appended only while a workspace is active;
    // otherwise the system prompt is left untouched (undefined result).
    if (!active) {
      return undefined;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${buildWorkspacePromptSection(active, sessionCwd)}` };
  });
}
