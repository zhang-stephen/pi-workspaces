// Footer statusline for the active workspace, per design section 10. Renders a
// single-line status via ctx.ui.setStatus under the fixed key
// "pi-workspaces" (keyed, stackable, persistent, theme-aware). renderStatus
// is pure: colors are injected as fg(color, text) so tests and non-UI
// contexts pass a plain passthrough. Healthy workspaces show
// "[ws] <name> (N roots)"; degraded ones show "(ok/N roots)"
// plus one warning-colored " ! <name> missing" marker per missing root.
// ASCII only - no emoji or symbols. Task 12 wires refreshStatus into
// session_start / load / unload; this module only reads ctx.ui.
import type { WorkspaceInfo } from "./path-resolver.ts";

/** Fixed setStatus key so the entry stacks cleanly with other extensions. */
const STATUS_KEY = "pi-workspaces";

/**
 * Render the one-line footer status for a workspace. `fg` injects theme
 * colors: accent for the icon and workspace name, dim for the counts,
 * warning for each missing-root marker.
 */
export function renderStatus(ws: WorkspaceInfo, fg: (color: string, text: string) => string): string {
  const ok = ws.roots.filter((r) => r.exists).length;
  const healthy = ok === ws.roots.length;
  const counts = healthy ? `(${ws.roots.length} roots)` : `(${ok}/${ws.roots.length} roots)`;
  let text = `${fg("accent", "[ws]")} ${fg("accent", ws.name)} ${fg("dim", counts)}`;
  if (!healthy) {
    for (const root of ws.roots) {
      if (!root.exists) text += fg("warning", ` ! ${root.name} missing`);
    }
  }
  return text;
}

/**
 * Push (or clear) the footer status for the active workspace. Called with
 * null on unload / when no workspace is active, which clears the keyed
 * entry by passing undefined. No-op-friendly in headless modes: pi's
 * print/RPC UI context exposes a no-op setStatus and may have no theme, in
 * which case colors fall back to a passthrough. theme.fg is a class method
 * on pi's Theme - it must be wrapped in a closure, because passing the bare
 * reference detaches `this` and crashes on this.fgColors.
 */
export function refreshStatus(ctx: any, ws: WorkspaceInfo | null): void {
  const ui = ctx.ui;
  if (!ui || typeof ui.setStatus !== "function") return;
  if (!ws) {
    ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const theme = ui.theme;
  const fg =
    theme && typeof theme.fg === "function"
      ? (color: string, text: string): string => theme.fg(color, text)
      : (_color: string, text: string): string => text;
  ui.setStatus(STATUS_KEY, renderStatus(ws, fg));
}
