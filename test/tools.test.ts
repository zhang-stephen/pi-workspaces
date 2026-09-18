// Unit tests for src/tools.ts: the read/write/edit and grep/find/ls
// overrides plus the bash override with its added cwd parameter. The
// overrides are registered into a mockPi and driven headlessly against
// temp-dir fixtures via mockCtx; no pi runtime and no LLM involved.
// grep/find go through the real ripgrep/fd binaries resolved from the pi
// tools directory (~/.pi/agent/bin), same as the built-ins do; bash goes
// through the real bundled shell.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeTempDir, mockCtx, mockPi, writeFile } from "./helpers.ts";
import type { RootInfo, WorkspaceInfo } from "../src/path-resolver.ts";
import { registerToolOverrides, type ToolDeps } from "../src/tools.ts";

// Temp dirs created by makeFixture; removed after every test.
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
  }
});

interface Fixture {
  sessionDir: string;
  rootA: RootInfo;
  rootB: RootInfo;
  ws: WorkspaceInfo;
}

function makeFixture(): Fixture {
  const base = makeTempDir("pi-workspaces-tools-test-");
  cleanup.push(base);
  const sessionDir = path.join(base, "session");
  const dirA = path.join(base, "root-a");
  const dirB = path.join(base, "root-b");
  for (const dir of [sessionDir, dirA, dirB]) fs.mkdirSync(dir, { recursive: true });
  writeFile(sessionDir, "notes.txt", "session notes\n");
  writeFile(dirA, "hello.txt", "alpha hello\n");
  writeFile(dirB, "hello.txt", "beta hello\n");
  // RootInfo paths are canonicalized by the store's health check; mirror that.
  const rootA: RootInfo = { name: "a", path: fs.realpathSync(dirA), exists: true };
  const rootB: RootInfo = { name: "b", path: fs.realpathSync(dirB), exists: true };
  return {
    sessionDir,
    rootA,
    rootB,
    ws: { name: "demo", roots: [rootA, rootB], origin: "project" },
  };
}

/** ToolDeps with a session-boundary first-touch tracker (one note per root). */
function makeDeps(
  ws: WorkspaceInfo | null,
  sessionDir: string,
  note?: string | null,
): { deps: ToolDeps; touched: string[] } {
  const touched: string[] = [];
  const deps: ToolDeps = {
    getActive: () => ws,
    sessionCwd: () => sessionDir,
    onFirstTouch: (root) => {
      if (touched.includes(root.name)) return null;
      touched.push(root.name);
      return note === undefined ? `first touch: root '${root.name}'` : note;
    },
  };
  return { deps, touched };
}

function registeredTools(ws: WorkspaceInfo | null, sessionDir: string, note?: string | null) {
  const pi = mockPi();
  const { deps, touched } = makeDeps(ws, sessionDir, note);
  registerToolOverrides(pi, deps);
  return { pi, deps, touched };
}

test("registers exactly read/write/edit/grep/find/ls, mirroring built-in schemas and docs", () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  assert.deepEqual([...pi.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
    const tool: any = pi.tools.get(name);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.label, "string");
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
    // The workspace syntax is appended to the built-in description.
    assert.match(tool.description, /@root-name\//);
    // Renderers stay omitted so built-in rendering is inherited by name.
    assert.equal(tool.renderCall, undefined);
    assert.equal(tool.renderResult, undefined);
  }
  // Parameter names mirror the built-in schemas exactly.
  const read: any = pi.tools.get("read");
  assert.deepEqual(Object.keys(read.parameters.properties), ["path", "offset", "limit"]);
  const write: any = pi.tools.get("write");
  assert.deepEqual(Object.keys(write.parameters.properties), ["path", "content"]);
  const edit: any = pi.tools.get("edit");
  assert.deepEqual(Object.keys(edit.parameters.properties), ["path", "edits"]);
  assert.deepEqual(Object.keys(edit.parameters.properties.edits.items.properties), ["oldText", "newText"]);
  // Search tools mirror the built-in schemas too; their path param is the
  // optional search/list scope (verified against dist .d.ts).
  const grep: any = pi.tools.get("grep");
  assert.deepEqual(Object.keys(grep.parameters.properties), [
    "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit",
  ]);
  const find: any = pi.tools.get("find");
  assert.deepEqual(Object.keys(find.parameters.properties), ["pattern", "path", "limit"]);
  const ls: any = pi.tools.get("ls");
  assert.deepEqual(Object.keys(ls.parameters.properties), ["path", "limit"]);
  // bash mirrors the built-in schema exactly, plus the added optional cwd
  // whose description documents the '@root-name/sub/dir' syntax.
  const bash: any = pi.tools.get("bash");
  assert.equal(bash.label, "bash");
  assert.ok(Array.isArray(bash.promptGuidelines) && bash.promptGuidelines.length > 0);
  assert.equal(bash.renderCall, undefined);
  assert.equal(bash.renderResult, undefined);
  assert.deepEqual(Object.keys(bash.parameters.properties), ["command", "timeout", "cwd"]);
  assert.match(bash.parameters.properties.cwd.description, /@root-name\/sub\/dir/);
  const builtinBash: any = createBashToolDefinition(sessionDir);
  assert.deepEqual(bash.parameters.properties.command, builtinBash.parameters.properties.command);
  assert.deepEqual(bash.parameters.properties.timeout, builtinBash.parameters.properties.timeout);
});

test("read: bare relative resolves against session cwd, @b/... against root b", async () => {
  const { sessionDir, ws } = makeFixture();
  // null note: this test asserts raw file content, not first-touch behavior.
  const { pi } = registeredTools(ws, sessionDir, null);
  const read: any = pi.tools.get("read");
  const ctx = mockCtx(sessionDir);
  const bare = await read.execute("c1", { path: "notes.txt" }, undefined, undefined, ctx);
  assert.ok(!bare.isError);
  assert.equal(bare.content[0].text, "session notes\n");
  const routedB = await read.execute("c2", { path: "@b/hello.txt" }, undefined, undefined, ctx);
  assert.ok(!routedB.isError);
  assert.equal(routedB.content[0].text, "beta hello\n");
  const routedA = await read.execute("c3", { path: "@a/hello.txt" }, undefined, undefined, ctx);
  assert.equal(routedA.content[0].text, "alpha hello\n");
});

test("first-touch note is prepended exactly once across two reads of a root", async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi, touched } = registeredTools(ws, sessionDir);
  const read: any = pi.tools.get("read");
  const ctx = mockCtx(sessionDir);
  const first = await read.execute("c1", { path: "@b/hello.txt" }, undefined, undefined, ctx);
  assert.equal(first.content.length, 2);
  assert.equal(first.content[0].text, "first touch: root 'b'");
  assert.equal(first.content[1].text, "beta hello\n");
  assert.deepEqual(touched, ["b"]);
  const second = await read.execute("c2", { path: "@b/hello.txt" }, undefined, undefined, ctx);
  assert.equal(second.content.length, 1);
  assert.equal(second.content[0].text, "beta hello\n");
  assert.deepEqual(touched, ["b"]);
});

test("unknown root throws naming the root and available roots", async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  const read: any = pi.tools.get("read");
  await assert.rejects(
    read.execute("c1", { path: "@zzz/x.txt" }, undefined, undefined, mockCtx(sessionDir)),
    /Unknown root 'zzz'/,
  );
});

test("write: @b/new.txt lands on disk; bare relative still targets session cwd", { timeout: 5000 }, async () => {
  const { sessionDir, rootB, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  const write: any = pi.tools.get("write");
  const ctx = mockCtx(sessionDir);
  // Routed writes touch root b, so the first-touch note precedes the success text.
  const routed = await write.execute("c1", { path: "@b/new.txt", content: "fresh content\n" }, undefined, undefined, ctx);
  assert.ok(!routed.isError);
  assert.equal(routed.content[0].text, "first touch: root 'b'");
  assert.match(routed.content[routed.content.length - 1].text, /Successfully wrote to/);
  assert.equal(fs.readFileSync(path.join(rootB.path, "new.txt"), "utf8"), "fresh content\n");
  const bare = await write.execute("c2", { path: "local.txt", content: "local\n" }, undefined, undefined, ctx);
  assert.ok(!bare.isError);
  assert.match(bare.content[bare.content.length - 1].text, /Successfully wrote to/);
  assert.equal(fs.readFileSync(path.join(sessionDir, "local.txt"), "utf8"), "local\n");
});

test("edit: @b/hello.txt is modified on disk with diff details", { timeout: 5000 }, async () => {
  const { sessionDir, rootB, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir, null);
  const edit: any = pi.tools.get("edit");
  const result = await edit.execute(
    "c1",
    { path: "@b/hello.txt", edits: [{ oldText: "beta", newText: "bravo" }] },
    undefined,
    undefined,
    mockCtx(sessionDir),
  );
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /Successfully replaced 1 block/);
  assert.equal(fs.readFileSync(path.join(rootB.path, "hello.txt"), "utf8"), "bravo hello\n");
  assert.equal(typeof result.details.diff, "string");
  assert.ok(result.details.patch.length > 0);
});

test("grep: @b searches only inside root b, never root a's same-named fixture", { timeout: 15000 }, async () => {
  const { sessionDir, ws } = makeFixture();
  // null note: assert raw search output, not first-touch behavior.
  const { pi } = registeredTools(ws, sessionDir, null);
  const grep: any = pi.tools.get("grep");
  const ctx = mockCtx(sessionDir);
  // Both roots hold a hello.txt, so a match text identifies which file was
  // actually searched; session cwd holds no 'hello' at all.
  const routedB = await grep.execute("c1", { pattern: "hello", path: "@b" }, undefined, undefined, ctx);
  assert.ok(!routedB.isError);
  assert.equal(routedB.content[0].text, "hello.txt:1: beta hello");
  const routedA = await grep.execute("c2", { pattern: "hello", path: "@a" }, undefined, undefined, ctx);
  assert.ok(!routedA.isError);
  assert.equal(routedA.content[0].text, "hello.txt:1: alpha hello");
  // A path inside the root that does not exist surfaces the built-in's
  // error, proving the wrapper propagates rejections instead of swallowing
  // them into empty results.
  await assert.rejects(
    grep.execute("c3", { pattern: "hello", path: "@b/nope" }, undefined, undefined, ctx),
    /Path not found/,
  );
});

test("find: @b locates the fixture file under root b only", { timeout: 15000 }, async () => {
  const { sessionDir, rootB, ws } = makeFixture();
  writeFile(rootB.path, "nested/beta-only.txt", "unique beta\n");
  const { pi } = registeredTools(ws, sessionDir, null);
  const find: any = pi.tools.get("find");
  const ctx = mockCtx(sessionDir);
  const routed = await find.execute("c1", { pattern: "beta-only.txt", path: "@b" }, undefined, undefined, ctx);
  assert.ok(!routed.isError);
  assert.equal(routed.content[0].text, "nested/beta-only.txt");
  const control = await find.execute("c2", { pattern: "beta-only.txt", path: "@a" }, undefined, undefined, ctx);
  assert.ok(!control.isError);
  assert.equal(control.content[0].text, "No files found matching pattern");
});

test("ls: @b lists root-b entries only; omitted path keeps the built-in default", { timeout: 15000 }, async () => {
  const { sessionDir, rootB, ws } = makeFixture();
  writeFile(rootB.path, "beta-only.txt", "unique beta\n");
  const { pi } = registeredTools(ws, sessionDir, null);
  const ls: any = pi.tools.get("ls");
  const ctx = mockCtx(sessionDir);
  const routed = await ls.execute("c1", { path: "@b" }, undefined, undefined, ctx);
  assert.ok(!routed.isError);
  assert.equal(routed.content[0].text, "beta-only.txt\nhello.txt");
  // The session file notes.txt must not leak into a root-b listing.
  const routedA = await ls.execute("c2", { path: "@a" }, undefined, undefined, ctx);
  assert.equal(routedA.content[0].text, "hello.txt");
  // grep/find/ls have an OPTIONAL path: omitting it must behave exactly like
  // the built-in default, i.e. list the session start directory.
  const bare = await ls.execute("c3", {}, undefined, undefined, ctx);
  assert.ok(!bare.isError);
  assert.equal(bare.content[0].text, "notes.txt");
});

test("no active workspace: bare relative works unchanged, @root errors", async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(null, sessionDir);
  const read: any = pi.tools.get("read");
  const ctx = mockCtx(sessionDir);
  const bare = await read.execute("c1", { path: "notes.txt" }, undefined, undefined, ctx);
  assert.ok(!bare.isError);
  assert.equal(bare.content[0].text, "session notes\n");
  await assert.rejects(
    read.execute("c2", { path: "@b/hello.txt" }, undefined, undefined, ctx),
    /No workspace is active/,
  );
  // Sanity: the fixture workspace really was inactive here.
  assert.equal(ws.name, "demo");
});

test("bash: pwd with cwd @b runs inside root b (basename, shell-format agnostic)", { timeout: 15000 }, async () => {
  const { sessionDir, ws } = makeFixture();
  // Default note: the routed cwd touches root b, so the first-touch note
  // precedes the command output (asserted here as part of the same call).
  const { pi } = registeredTools(ws, sessionDir);
  const bash: any = pi.tools.get("bash");
  const result = await bash.execute("c1", { command: "pwd", cwd: "@b" }, undefined, undefined, mockCtx(sessionDir));
  assert.ok(!result.isError);
  assert.equal(result.content[0].text, "first touch: root 'b'");
  // pi's bundled shell may print Windows paths as '/c/...' or 'C:/...':
  // assert the directory basename, never the drive-letter format.
  const out = result.content[result.content.length - 1].text;
  assert.ok(out.includes("root-b"), `expected root b's dir in pwd output, got: ${out}`);
  assert.ok(!out.includes("root-a"), `root a must not appear in pwd output, got: ${out}`);
  assert.ok(!out.includes("session"), `session dir must not appear in pwd output, got: ${out}`);
});

test("bash: omitted cwd runs in the session cwd", { timeout: 15000 }, async () => {
  const { sessionDir, ws } = makeFixture();
  // null note: assert raw command output, not first-touch behavior.
  const { pi } = registeredTools(ws, sessionDir, null);
  const bash: any = pi.tools.get("bash");
  const result = await bash.execute("c1", { command: "pwd" }, undefined, undefined, mockCtx(sessionDir));
  assert.ok(!result.isError);
  const out = result.content[result.content.length - 1].text;
  assert.ok(out.includes("session"), `expected session dir in pwd output, got: ${out}`);
});

test("bash: unknown root in cwd throws naming the root", { timeout: 15000 }, async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  const bash: any = pi.tools.get("bash");
  await assert.rejects(
    bash.execute("c1", { command: "pwd", cwd: "@zzz" }, undefined, undefined, mockCtx(sessionDir)),
    /Unknown root 'zzz'/,
  );
});
