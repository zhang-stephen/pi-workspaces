// Unit tests for src/prompt-inject.ts: the workspace section appended to
// the system prompt, the once-per-root first-touch tracker, and the
// constraint-file reader (AGENTS.md preferred over CLAUDE.md, else a
// fallback note naming the primary root). The section builder and tracker
// are pure; the reader uses temp-dir fixtures.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeTempDir, writeFile } from "./helpers.ts";
import type { RootInfo, WorkspaceInfo } from "../src/path-resolver.ts";
import {
  buildWorkspacePromptSection,
  FirstTouchTracker,
  makeConstraintReader,
} from "../src/prompt-inject.ts";

// Temp dirs created by the fixture helpers; removed after every test.
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
  }
});

function root(base: string, name: string, exists = true): RootInfo {
  return { name, path: path.join(base, name), exists };
}

test("prompt section: root map with marks, path rules, bash cwd, constraint policy, pure ASCII", () => {
  const base = makeTempDir("pi-workspaces-prompt-test-");
  cleanup.push(base);
  const alpha = root(base, "alpha");
  const beta = root(base, "beta");
  const ghost = root(base, "ghost", false);
  const ws: WorkspaceInfo = { name: "demo", roots: [alpha, beta, ghost], primary: "alpha", origin: "project" };
  const sessionCwd = path.join(base, "session");

  const section = buildWorkspacePromptSection(ws, sessionCwd);
  const lineOf = (needle: string): string => {
    const line = section.split("\n").find((l) => l.includes(needle));
    assert.ok(line, `expected a line containing ${needle}`);
    return line as string;
  };

  // Header names the workspace.
  assert.match(section, /Workspace 'demo'/);

  // Root map: '@name -> path' with (primary)/(MISSING) marks.
  const alphaLine = lineOf("@alpha");
  assert.ok(alphaLine.includes(alpha.path), "alpha line shows its path");
  assert.ok(alphaLine.includes("(primary)"), "primary root marked");
  const betaLine = lineOf("@beta");
  assert.ok(betaLine.includes(beta.path), "beta line shows its path");
  assert.ok(!betaLine.includes("(primary)") && !betaLine.includes("(MISSING)"), "unmarked root carries no mark");
  const ghostLine = lineOf("@ghost");
  assert.ok(ghostLine.includes(ghost.path), "ghost line shows its path");
  assert.ok(ghostLine.includes("(MISSING)"), "missing root marked");

  // Three path rules: bare relative (session cwd), '@root-name/...', absolute.
  assert.match(section, /[Bb]are relative paths/);
  assert.ok(section.includes(sessionCwd), "session start directory is named");
  assert.match(section, /@root-name\/path/);
  assert.match(section, /[Aa]bsolute paths/);

  // bash cwd usage.
  assert.match(section, /bash/);
  assert.match(section, /\bcwd\b/);

  // Constraint fallback policy names the primary root.
  assert.match(section, /AGENTS\.md\/CLAUDE\.md/);
  assert.match(section, /fall back/);
  assert.ok(section.includes("'@alpha'"), "policy names the primary root");

  // Pure ASCII: no CJK, emoji, or smart quotes.
  assert.ok(!/[^\x00-\x7F]/.test(section), "prompt section must be pure ASCII");
});

test("first-touch tracker injects once per root until reset", () => {
  const reads: string[] = [];
  const tracker = new FirstTouchTracker((r) => {
    reads.push(r.name);
    return `note for ${r.name}`;
  });
  const alpha: RootInfo = { name: "alpha", path: path.join(os.tmpdir(), "pi-workspaces-tracker-alpha"), exists: true };
  const beta: RootInfo = { name: "beta", path: path.join(os.tmpdir(), "pi-workspaces-tracker-beta"), exists: true };

  // First touch per root injects; the read runs lazily at touch time.
  assert.equal(tracker.onTouch(alpha), "note for alpha");
  assert.equal(tracker.onTouch(alpha), null, "same root is not re-injected");
  assert.equal(tracker.onTouch(beta), "note for beta");
  assert.deepEqual(reads, ["alpha", "beta"], "read called once per root, lazily");

  // reset() clears the per-session memory.
  tracker.reset();
  assert.equal(tracker.onTouch(alpha), "note for alpha");
  assert.deepEqual(reads, ["alpha", "beta", "alpha"]);
});

test("constraint reader prefers AGENTS.md over CLAUDE.md, else names the primary root", () => {
  const base = makeTempDir("pi-workspaces-constraints-test-");
  cleanup.push(base);

  const bothDir = path.join(base, "both");
  writeFile(bothDir, "AGENTS.md", "AGENTS RULES\n");
  writeFile(bothDir, "CLAUDE.md", "CLAUDE RULES\n");
  const claudeDir = path.join(base, "claude-only");
  writeFile(claudeDir, "CLAUDE.md", "CLAUDE ONLY RULES\n");
  const emptyDir = path.join(base, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });

  // getPrimaryName is consulted lazily, only when the fallback fires.
  let primaryCalls = 0;
  const read = makeConstraintReader(() => {
    primaryCalls++;
    return "alpha";
  });

  const both = read({ name: "both", path: bothDir, exists: true });
  assert.match(both, /from AGENTS\.md/);
  assert.ok(both.includes("AGENTS RULES"));
  assert.ok(!both.includes("CLAUDE RULES"), "AGENTS.md wins when both exist");

  const claudeOnly = read({ name: "claude", path: claudeDir, exists: true });
  assert.match(claudeOnly, /from CLAUDE\.md/);
  assert.ok(claudeOnly.includes("CLAUDE ONLY RULES"));

  const fallback = read({ name: "empty", path: emptyDir, exists: true });
  assert.match(fallback, /no AGENTS\.md or CLAUDE\.md/);
  assert.ok(fallback.includes("'@alpha'"), "fallback note names the primary root");
  assert.equal(primaryCalls, 1, "getPrimaryName consulted once, only for the fallback");
});

test("constraint reader warns instead of throwing when the constraint file exists but is unreadable", () => {
  const base = makeTempDir("pi-workspaces-constraints-warn-test-");
  cleanup.push(base);

  // A directory named AGENTS.md passes existsSync but makes readFileSync
  // throw (EISDIR/EPERM on Windows), simulating an unreadable constraint
  // file without chmod, which is unreliable on Windows.
  const trickyDir = path.join(base, "tricky");
  fs.mkdirSync(path.join(trickyDir, "AGENTS.md"), { recursive: true });

  let primaryCalls = 0;
  const read = makeConstraintReader(() => {
    primaryCalls++;
    return "alpha";
  });

  // Must not throw; the caller receives a WARNING note instead.
  const note = read({ name: "tricky", path: trickyDir, exists: true });

  assert.match(note, /^\[pi-workspaces\] WARNING: constraints for root 'tricky'/, "warning names the root");
  assert.match(note, /could not be read: .+\./, "warning includes the error reason");
  assert.ok(note.includes("Continuing without root-specific constraints."));
  assert.ok(!note.includes("(from AGENTS.md)"), "no constraint contents are injected");
  assert.ok(!note.includes("'@alpha'"), "must not fall back to the primary root's constraints");
  assert.equal(primaryCalls, 0, "fallback primary lookup is not consulted");
  assert.ok(!/[^\x00-\x7F]/.test(note), "warning must be pure ASCII");
});
