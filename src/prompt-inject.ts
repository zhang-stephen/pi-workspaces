// System-prompt injection for the active workspace plus the first-touch
// constraint reader. buildWorkspacePromptSection renders the workspace
// section appended to the system prompt (pure, ASCII only); FirstTouchTracker
// enforces the once-per-root-per-session injection contract; and
// makeConstraintReader builds the note for one root, preferring AGENTS.md
// over CLAUDE.md and falling back to a note naming the primary root.
// Task 12 wires these into the before_agent_start event and the tools'
// onFirstTouch callback; this module stays pure of any extension API.
import * as fs from "node:fs";
import * as path from "node:path";
import type { RootInfo, WorkspaceInfo } from "./path-resolver.ts";

/**
 * Render the workspace section appended to the system prompt when a
 * workspace is active. Covers, in order: the root map ('@name -> path'
 * lines with (primary)/(MISSING) marks), the three path rules (bare
 * relative against the session start directory, '@root-name/path',
 * absolute), the bash cwd parameter, and the constraint fallback policy.
 * Pure ASCII by contract - a test asserts /[^\x00-\x7F]/ does not match.
 */
export function buildWorkspacePromptSection(ws: WorkspaceInfo, sessionCwd: string): string {
  const lines: string[] = [];
  lines.push(`## Workspace '${ws.name}'`);
  lines.push("");
  lines.push("Root map:");
  for (const root of ws.roots) {
    const marks = [root.name === ws.primary ? "(primary)" : "", root.exists ? "" : "(MISSING)"]
      .filter((m) => m !== "")
      .join(" ");
    lines.push(`  @${root.name} -> ${root.path}${marks === "" ? "" : ` ${marks}`}`);
  }
  lines.push("");
  lines.push("Path rules (apply to every file tool and to the bash cwd parameter):");
  lines.push(
    `1. Bare relative paths always resolve against the session start directory (${sessionCwd}); they never resolve against a root.`,
  );
  lines.push(
    "2. '@root-name/path' addresses a workspace root, e.g. '@backend/src/app.ts'; '@backend' alone is the root directory itself. Unknown root names and '..' escapes are reported as errors.",
  );
  lines.push(
    "3. Absolute paths work everywhere and are attributed to their owning root when inside one.",
  );
  lines.push("");
  lines.push("bash cwd:");
  lines.push(
    "Pass cwd ('@root-name/sub/dir' or an absolute path) to run a command inside a root; omit cwd to run in the session start directory.",
  );
  lines.push("");
  lines.push("Constraints:");
  lines.push(
    `Each root's own AGENTS.md/CLAUDE.md governs work inside that root and is injected the first time a tool call touches the root this session. Roots without either file fall back to the primary root's constraints ('@${ws.primary}').`,
  );
  return lines.join("\n");
}

/**
 * Enforces the once-per-root-per-session constraint injection: the first
 * onTouch of a root delegates to the injected read function and returns
 * its note; later touches of the same root (by name) return null.
 * reset() clears the memory on workspace load/unload. The read runs lazily
 * at touch time, so untouched roots cost nothing.
 */
export class FirstTouchTracker {
  private readonly seen = new Set<string>();
  private readonly read: (root: RootInfo) => string;

  constructor(read: (root: RootInfo) => string) {
    this.read = read;
  }

  onTouch(root: RootInfo): string | null {
    if (this.seen.has(root.name)) return null;
    this.seen.add(root.name);
    return this.read(root);
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * Build the constraint reader handed to FirstTouchTracker. For a root with
 * AGENTS.md (preferred) or CLAUDE.md, returns a marker line plus the file
 * contents; for a root with neither, returns a one-line fallback note
 * naming the primary root. getPrimaryName is consulted lazily, only when
 * the fallback fires, so the primary can change between calls.
 */
export function makeConstraintReader(getPrimaryName: () => string): (root: RootInfo) => string {
  return (root: RootInfo): string => {
    const agentsPath = path.join(root.path, "AGENTS.md");
    const claudePath = path.join(root.path, "CLAUDE.md");
    if (fs.existsSync(agentsPath)) {
      return `[pi-workspaces] Constraints for root '@${root.name}' (from AGENTS.md):\n${fs.readFileSync(agentsPath, "utf8")}`;
    }
    if (fs.existsSync(claudePath)) {
      return `[pi-workspaces] Constraints for root '@${root.name}' (from CLAUDE.md):\n${fs.readFileSync(claudePath, "utf8")}`;
    }
    return (
      `[pi-workspaces] Root '@${root.name}' has no AGENTS.md or CLAUDE.md; no root-specific constraints. ` +
      `Follow the primary root '@${getPrimaryName()}' constraints instead.`
    );
  };
}
