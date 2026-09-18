// Unit tests for src/prompt-inject.ts: the workspace section appended to
// the system prompt, the once-per-root first-touch tracker, and the
// constraint-file reader (AGENTS.md preferred over CLAUDE.md, then the
// session-root fallback chain of D6, then a plain "no constraints" note).
// The section builder and tracker are pure; the reader uses temp-dir fixtures.
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

test("prompt section: root map with MISSING marks, path rules, bash cwd, constraint policy, pure ASCII", () => {
  const base = makeTempDir("pi-workspaces-prompt-test-");
  cleanup.push(base);
  const alpha = root(base, "alpha");
  const beta = root(base, "beta");
  const ghost = root(base, "ghost", false);
  const ws: WorkspaceInfo = { name: "demo", roots: [alpha, beta, ghost], origin: "project" };
  const sessionCwd = path.join(beta.path, "sub");

  const section = buildWorkspacePromptSection(ws, sessionCwd);
  const lineOf = (needle: string): string => {
    const line = section.split("\n").find((l) => l.includes(needle));
    assert.ok(line, `expected a line containing ${needle}`);
    return line as string;
  };

  // Header names the workspace.
  assert.match(section, /Workspace 'demo'/);

  // Root map: '@name -> path' with (MISSING) marks only - no (primary).
  const alphaLine = lineOf("@alpha");
  assert.ok(alphaLine.includes(alpha.path), "alpha line shows its path");
  assert.ok(!alphaLine.includes("(primary)") && !alphaLine.includes("(MISSING)"), "unmarked root carries no mark");
  const ghostLine = lineOf("@ghost");
  assert.ok(ghostLine.includes(ghost.path), "ghost line shows its path");
  assert.ok(ghostLine.includes("(MISSING)"), "missing root marked");
  assert.ok(!section.includes("(primary)"), "no primary marks anywhere");

  // Three path rules: bare relative (session cwd), '@root-name/...', absolute.
  assert.match(section, /[Bb]are relative paths/);
  assert.ok(section.includes(sessionCwd), "session start directory is named");
  assert.match(section, /@root-name\/path/);
  assert.match(section, /[Aa]bsolute paths/);

  // bash cwd usage.
  assert.match(section, /bash/);
  assert.match(section, /\bcwd\b/);

  // Constraint fallback policy names the session root (cwd sits in beta).
  assert.match(section, /AGENTS\.md\/CLAUDE\.md/);
  assert.match(section, /fall back/);
  assert.ok(section.includes("'@beta'"), "policy names the session root");

  // Pure ASCII: no CJK, emoji, or smart quotes.
  assert.ok(!/[^\x00-\x7F]/.test(section), "prompt section must be pure ASCII");
});

test("prompt section: cwd outside every root means no fallback", () => {
  const base = makeTempDir("pi-workspaces-prompt-test-");
  cleanup.push(base);
  const alpha = root(base, "alpha");
  const ws: WorkspaceInfo = { name: "demo", roots: [alpha], origin: "project" };
  const outside = path.join(base, "elsewhere");

  const section = buildWorkspacePromptSection(ws, outside);

  assert.match(section, /no fallback/);
  assert.ok(!section.includes("'@alpha')."), "no root is named as fallback");
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

test("first-touch tracker counts a null (skipped) read as seen", () => {
  let reads = 0;
  const tracker = new FirstTouchTracker(() => {
    reads++;
    return null;
  });
  const alpha: RootInfo = { name: "alpha", path: os.tmpdir(), exists: true };

  assert.equal(tracker.onTouch(alpha), null);
  assert.equal(tracker.onTouch(alpha), null);
  assert.equal(reads, 1, "the skip happens once; later touches do not re-read");
});

test("constraint reader prefers AGENTS.md over CLAUDE.md from the touched root", () => {
  const base = makeTempDir("pi-workspaces-constraints-test-");
  cleanup.push(base);

  const bothDir = path.join(base, "both");
  writeFile(bothDir, "AGENTS.md", "AGENTS RULES\n");
  writeFile(bothDir, "CLAUDE.md", "CLAUDE RULES\n");
  const claudeDir = path.join(base, "claude-only");
  writeFile(claudeDir, "CLAUDE.md", "CLAUDE ONLY RULES\n");

  const read = makeConstraintReader(() => null, () => path.join(base, "nowhere"));

  const both = read({ name: "both", path: bothDir, exists: true });
  assert.match(both as string, /from AGENTS\.md/);
  assert.ok((both as string).includes("AGENTS RULES"));
  assert.ok(!(both as string).includes("CLAUDE RULES"), "AGENTS.md wins when both exist");

  const claudeOnly = read({ name: "claude", path: claudeDir, exists: true });
  assert.match(claudeOnly as string, /from CLAUDE\.md/);
  assert.ok((claudeOnly as string).includes("CLAUDE ONLY RULES"));
});

test("constraint reader falls back to the session root's constraints (D6)", () => {
  const base = makeTempDir("pi-workspaces-constraints-test-");
  cleanup.push(base);

  // Session root "home" carries the constraints; touched root "bare" has none.
  const homeDir = path.join(base, "home");
  writeFile(homeDir, "AGENTS.md", "SESSION ROOT RULES\n");
  const bareDir = path.join(base, "bare");
  fs.mkdirSync(bareDir, { recursive: true });
  const ws: WorkspaceInfo = {
    name: "demo",
    roots: [
      { name: "home", path: homeDir, exists: true },
      { name: "bare", path: bareDir, exists: true },
    ],
    origin: "project",
  };
  const sessionCwd = path.join(homeDir, "sub");

  const read = makeConstraintReader(() => ws, () => sessionCwd);
  const note = read({ name: "bare", path: bareDir, exists: true });

  assert.match(note as string, /no AGENTS\.md or CLAUDE\.md/);
  assert.match(note as string, /fall back to the session root '@home'/);
  assert.match(note as string, /from AGENTS\.md/);
  assert.ok((note as string).includes("SESSION ROOT RULES"));
});

test("constraint reader: unrelated load has no fallback; session root without files is named", () => {
  const base = makeTempDir("pi-workspaces-constraints-test-");
  cleanup.push(base);

  const bareDir = path.join(base, "bare");
  fs.mkdirSync(bareDir, { recursive: true });
  const emptyHome = path.join(base, "home");
  fs.mkdirSync(emptyHome, { recursive: true });
  const ws: WorkspaceInfo = {
    name: "demo",
    roots: [
      { name: "home", path: emptyHome, exists: true },
      { name: "bare", path: bareDir, exists: true },
    ],
    origin: "project",
  };
  const bare: RootInfo = { name: "bare", path: bareDir, exists: true };

  // Unrelated load: the cwd sits inside no root -> no fallback at all (D6).
  const unrelated = makeConstraintReader(() => ws, () => path.join(base, "elsewhere"));
  const outsideNote = unrelated(bare);
  assert.match(outsideNote as string, /no AGENTS\.md or CLAUDE\.md; no root-specific constraints\./);
  assert.ok(!(outsideNote as string).includes("'@home'"), "no session root is named");

  // Session root exists but carries no constraint files either.
  const related = makeConstraintReader(() => ws, () => emptyHome);
  const insideNote = related(bare);
  assert.match(insideNote as string, /session root '@home' provides none either/);
});

// 16.4: reading the constraint file itself must not print the file twice.
test("constraint reader skips injection when the touched file IS the constraint file", () => {
  const base = makeTempDir("pi-workspaces-constraints-test-");
  cleanup.push(base);

  const yoloDir = path.join(base, "yolo");
  writeFile(yoloDir, "AGENTS.md", "YOLO RULES\n");
  const yolo: RootInfo = { name: "yolo", path: yoloDir, exists: true };
  const read = makeConstraintReader(() => null, () => path.join(base, "nowhere"));

  // The touched file is the constraint file: skip (null), do not duplicate.
  assert.equal(read(yolo, path.join(yoloDir, "AGENTS.md")), null);
  // Any other file of the same root injects normally.
  const note = read(yolo, path.join(yoloDir, "src", "index.ts"));
  assert.match(note as string, /from AGENTS\.md/);
  // No touched path (e.g. a bash call without cwd attribution): inject.
  assert.match(read(yolo) as string, /from AGENTS\.md/);
});

test("constraint reader warns instead of throwing when the constraint file exists but is unreadable", () => {
  const base = makeTempDir("pi-workspaces-constraints-warn-test-");
  cleanup.push(base);

  // A directory named AGENTS.md passes existsSync but makes readFileSync
  // throw (EISDIR/EPERM on Windows), simulating an unreadable constraint
  // file without chmod, which is unreliable on Windows.
  const trickyDir = path.join(base, "tricky");
  fs.mkdirSync(path.join(trickyDir, "AGENTS.md"), { recursive: true });

  const read = makeConstraintReader(() => null, () => path.join(base, "nowhere"));

  // Must not throw; the caller receives a WARNING note instead.
  const note = read({ name: "tricky", path: trickyDir, exists: true });

  assert.match(note as string, /^\[pi-workspaces\] WARNING: constraints for root 'tricky'/, "warning names the root");
  assert.match(note as string, /could not be read: .+\./, "warning includes the error reason");
  assert.ok((note as string).includes("Continuing without root-specific constraints."));
  assert.ok(!(note as string).includes("(from AGENTS.md)"), "no constraint contents are injected");
  assert.ok(!/[^\x00-\x7F]/.test(note as string), "warning must be pure ASCII");
});
