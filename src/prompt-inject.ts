// System-prompt injection for the active workspace plus the first-touch
// constraint reader. buildWorkspacePromptSection renders the workspace
// section appended to the system prompt (pure, ASCII only); FirstTouchTracker
// enforces the once-per-root-per-session injection contract; and
// makeConstraintReader builds the note for one root, preferring AGENTS.md
// over CLAUDE.md and falling back to the session root (the root containing
// the session cwd) when the touched root has neither file (D6).
// index.ts wires these into the before_agent_start event and the tools'
// onFirstTouch callback; this module stays pure of any extension API.
import * as fs from "node:fs";
import * as path from "node:path";
import { owningRoot, pathKey, type RootInfo, type WorkspaceInfo } from "./path-resolver.ts";

/**
 * Render the workspace section appended to the system prompt when a
 * workspace is active. Covers, in order: the root map ('@name -> path'
 * lines with (MISSING) marks), the three path rules (bare
 * relative against the session start directory, '@root-name/path',
 * absolute), the bash cwd parameter, and the constraint fallback policy
 * (session-root fallback when the cwd is inside a root, none otherwise).
 * Pure ASCII by contract - a test asserts /[^\x00-\x7F]/ does not match.
 */
export function buildWorkspacePromptSection(ws: WorkspaceInfo, sessionCwd: string): string {
  const sessionRoot = owningRoot(ws, sessionCwd);
  const lines: string[] = [];
  lines.push(`## Workspace '${ws.name}'`);
  lines.push("");
  lines.push("Root map:");
  for (const root of ws.roots) {
    const marks = root.exists ? "" : " (MISSING)";
    lines.push(`  @${root.name} -> ${root.path}${marks}`);
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
    "Each root's own AGENTS.md/CLAUDE.md governs work inside that root and is injected the first time a tool call touches the root this session. " +
      (sessionRoot
        ? `Roots without either file fall back to the constraints of the root containing the session directory ('@${sessionRoot.name}').`
        : "Roots without either file have no fallback (the session directory is not inside any root)."),
  );
  return lines.join("\n");
}

/**
 * Enforces the once-per-root-per-session constraint injection: the first
 * onTouch of a root delegates to the injected read function and returns
 * its note; later touches of the same root (by name) return null.
 * The root is recorded as seen after the read returns (including a null
 * self-read skip, where the tool result itself delivered the file), so a
 * throwing read does not suppress a later retry. reset() clears the
 * memory on workspace load/unload. The read runs lazily at touch time, so
 * untouched roots cost nothing.
 */
export class FirstTouchTracker {
  private readonly seen = new Set<string>();
  private readonly read: (root: RootInfo, touchedPath?: string) => string | null;

  constructor(read: (root: RootInfo, touchedPath?: string) => string | null) {
    this.read = read;
  }

  onTouch(root: RootInfo, touchedPath?: string): string | null {
    if (this.seen.has(root.name)) return null;
    const note = this.read(root, touchedPath);
    this.seen.add(root.name);
    return note;
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * Replace non-ASCII characters with '?' so injected notes stay pure ASCII
 * even when an underlying error message is not.
 */
function sanitizeForAscii(text: string): string {
  return text.replace(/[^\x00-\x7F]/g, "?");
}

/** The constraint file candidates of a root, in preference order. */
const CONSTRAINT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** The first existing constraint file inside `rootPath`, or null. */
function findConstraintFile(rootPath: string): { file: string; fileName: string } | null {
  for (const fileName of CONSTRAINT_FILES) {
    const file = path.join(rootPath, fileName);
    if (fs.existsSync(file)) return { file, fileName };
  }
  return null;
}

/**
 * Build the constraint reader handed to FirstTouchTracker (D6). Fallback
 * chain for a touched root: the root's own AGENTS.md (preferred) or
 * CLAUDE.md; else the session root's (the root containing the session cwd)
 * AGENTS.md or CLAUDE.md; else a one-line "no constraints" note. An
 * unrelated load (the cwd inside no root) has no session root and hence no
 * fallback - the cwd's own constraints already reach the model via pi's
 * native project instructions.
 *
 * A constraint file that exists but cannot be read (permissions, etc.)
 * yields a WARNING note naming the root and the error instead of throwing;
 * it deliberately does NOT fall back further, to avoid applying mismatched
 * rules.
 *
 * 16.4: when the touched file IS the constraint file about to be injected
 * (e.g. reading '@yolo/AGENTS.md'), the injection is skipped (null) - the
 * tool result itself already delivered the content, printing it twice
 * would be noise.
 *
 * getWorkspace/getSessionCwd are consulted lazily at touch time, so the
 * active workspace and session cwd can change between calls.
 */
export function makeConstraintReader(
  getWorkspace: () => WorkspaceInfo | null,
  getSessionCwd: () => string,
): (root: RootInfo, touchedPath?: string) => string | null {
  return (root: RootInfo, touchedPath?: string): string | null => {
    const own = findConstraintFile(root.path);
    let sessionRoot: RootInfo | null = null;
    let target = own;
    if (!target) {
      const ws = getWorkspace();
      const cwd = getSessionCwd();
      const candidate = ws && cwd ? owningRoot(ws, cwd) : null;
      if (candidate && candidate.name !== root.name) {
        sessionRoot = candidate;
        target = findConstraintFile(candidate.path);
      }
    }

    if (!target) {
      return sessionRoot
        ? `[pi-workspaces] Root '@${root.name}' has no AGENTS.md or CLAUDE.md, and the session root '@${sessionRoot.name}' provides none either; no root-specific constraints.`
        : `[pi-workspaces] Root '@${root.name}' has no AGENTS.md or CLAUDE.md; no root-specific constraints.`;
    }

    // 16.4: the touched file is the constraint file itself - skip.
    if (touchedPath !== undefined && pathKey(touchedPath) === pathKey(target.file)) {
      return null;
    }

    let contents: string;
    try {
      contents = fs.readFileSync(target.file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return (
        `[pi-workspaces] WARNING: constraints for root '${root.name}' (${target.file}) could not be read: ` +
        `${sanitizeForAscii(message)}. Continuing without root-specific constraints.`
      );
    }
    if (sessionRoot) {
      return (
        `[pi-workspaces] Root '@${root.name}' has no AGENTS.md or CLAUDE.md; ` +
        `constraints fall back to the session root '@${sessionRoot.name}' (from ${target.fileName}):\n${contents}`
      );
    }
    return `[pi-workspaces] Constraints for root '@${root.name}' (from ${target.fileName}):\n${contents}`;
  };
}
