// Extension entry (wiring only): assembles the seven tool overrides, the
// /workspace command, the before_agent_start workspace section, the
// first-touch constraint injection, the footer statusline and (on UI
// sessions) the @root autocomplete provider, and drives session activation
// per design section 4:
//   session_start -> loadAll -> notify warnings/collisions -> auto-load
//   when the session cwd equals a workspace's primary root and
//   autoLoadInPrimary resolves true -> journal restore (session resume)
//   -> select prompt when ctx.hasUI: the containing workspaces only when
//   the cwd sits in a non-primary root, otherwise every promptable one.
// setActive is the single activation point: it owns the first-touch
// tracker reset, the statusline refresh and the pi-workspaces:active
// journal entry - nothing else writes the journal.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAutocompleteProvider } from "./src/autocomplete.ts";
import { registerWorkspaceCommands } from "./src/commands.ts";
import { isInside, type WorkspaceInfo } from "./src/path-resolver.ts";
import { buildWorkspacePromptSection, FirstTouchTracker, makeConstraintReader } from "./src/prompt-inject.ts";
import { refreshStatus } from "./src/statusline.ts";
import { registerToolOverrides } from "./src/tools.ts";
import { loadAll, loadGlobalConfig, resolveOptions, toWorkspaceInfo } from "./src/workspace-store.ts";

/** Journal entry type: the active workspace name, recorded on every switch. */
const JOURNAL_TYPE = "pi-workspaces:active";

/**
 * Lexical path equality for the auto-load comparison: separators
 * normalized to "/", a leading win32 drive letter lowercased, and a
 * redundant trailing slash dropped (the same normalization rule as the
 * resolver's containment comparison). Root paths arrive canonicalized
 * from the store; the session cwd is normalized the same lexical way.
 */
function pathKey(p: string): string {
  let key = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(key)) key = key[0].toLowerCase() + key.slice(1);
  if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
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

export default function piWorkspaces(pi: ExtensionAPI): void {
  // Runtime state. Tools and prompt rendering read both through getters so
  // they always observe the current values; sessionCwd is refreshed from
  // ctx.cwd on every session_start (never a captured value).
  let active: WorkspaceInfo | null = null;
  let sessionCwd = "";

  const tracker = new FirstTouchTracker(makeConstraintReader(() => active?.primary ?? ""));
  const getActive = (): WorkspaceInfo | null => active;
  const getSessionCwd = (): string => sessionCwd;

  /**
   * The single activation point. Owns every side effect of a workspace
   * switch: reset the once-per-root constraint tracker, refresh the footer
   * status (when a session ctx is available) and journal the new state so
   * /resume can restore it (design section 4, step 4). Unload journals
   * { name: null }.
   */
  const setActive = (ws: WorkspaceInfo | null, ctx?: unknown): void => {
    active = ws;
    tracker.reset();
    if (ctx) refreshStatus(ctx, ws);
    pi.appendEntry(JOURNAL_TYPE, { name: ws?.name ?? null });
  };

  registerToolOverrides(pi, {
    getActive,
    sessionCwd: getSessionCwd,
    onFirstTouch: (root) => tracker.onTouch(root),
  });
  registerWorkspaceCommands(pi, { getActive, setActive });

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;

    // @root editor completion stacks on the built-in provider; only
    // dialog-capable sessions have an editor to complete in.
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider(createAutocompleteProvider(getActive));
    }

    const { merged, collisions, warnings } = loadAll(ctx.cwd);
    // Global defaults flow through resolveOptions per definition; the
    // sparse config object itself is never read key-by-key.
    const globalDefaults = loadGlobalConfig();
    for (const warning of warnings) {
      ctx.ui.notify(warning, "warning");
    }
    for (const name of collisions) {
      ctx.ui.notify(
        `Workspace '${name}' is defined in both the global and project sources; the project definition wins.`,
        "warning",
      );
    }

    // 1. Auto-load: the session cwd equals a workspace's primary root and
    //    its autoLoadInPrimary resolves true.
    for (const { def, origin } of merged) {
      const primary = def.roots.find((r) => r.name === def.primary);
      if (primary && samePath(primary.path, ctx.cwd) && resolveOptions(def, globalDefaults).autoLoadInPrimary) {
        const ws = toWorkspaceInfo(def, origin);
        setActive(ws, ctx);
        ctx.ui.notify(`Workspace '${ws.name}' auto-loaded (session directory is its primary root).`);
        return;
      }
    }

    // 2. Session restore: the journal entry written by setActive is the
    //    resume signal. ReadonlySessionManager exposes getEntries(), so
    //    the last pi-workspaces:active entry of the current session
    //    re-activates its workspace when the cwd matched nothing. The last
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

    // 3. Ask: two layers. When the cwd sits inside some workspace's
    //    non-primary root, offer only those containing workspaces;
    //    otherwise offer every workspace whose promptInOtherDirs resolves
    //    true. Always with a "Don't load" escape hatch.
    const containing = merged.filter(({ def }) =>
      def.roots.some((r) => r.name !== def.primary && isInside(r.path, ctx.cwd)),
    );
    const pool = containing.length > 0 ? containing : merged;
    const candidates = pool.filter(({ def }) => resolveOptions(def, globalDefaults).promptInOtherDirs);
    if (candidates.length > 0 && ctx.hasUI) {
      const names = candidates.map((c) => c.def.name);
      const choice = await ctx.ui.select("Load a workspace for this session?", [...names, "Don't load"]);
      if (choice !== undefined && choice !== "Don't load") {
        const entry = candidates.find((c) => c.def.name === choice);
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
