// Unit tests for src/tools.ts: the read/write/edit overrides. The overrides
// are registered into a mockPi and driven headlessly against temp-dir
// fixtures via mockCtx; no pi runtime and no LLM involved.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
    ws: { name: "demo", roots: [rootA, rootB], primary: "a", origin: "project" },
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

test("registers exactly read/write/edit, mirroring built-in schemas and docs", () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  assert.deepEqual([...pi.tools.keys()].sort(), ["edit", "read", "write"]);
  for (const name of ["read", "write", "edit"]) {
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

test("unknown root returns an isError result naming the root and available roots", async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(ws, sessionDir);
  const read: any = pi.tools.get("read");
  const result = await read.execute("c1", { path: "@zzz/x.txt" }, undefined, undefined, mockCtx(sessionDir));
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Unknown root 'zzz'/);
  assert.match(result.content[0].text, /'a'/);
  assert.match(result.content[0].text, /'b'/);
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

test("no active workspace: bare relative works unchanged, @root errors", async () => {
  const { sessionDir, ws } = makeFixture();
  const { pi } = registeredTools(null, sessionDir);
  const read: any = pi.tools.get("read");
  const ctx = mockCtx(sessionDir);
  const bare = await read.execute("c1", { path: "notes.txt" }, undefined, undefined, ctx);
  assert.ok(!bare.isError);
  assert.equal(bare.content[0].text, "session notes\n");
  const routed = await read.execute("c2", { path: "@b/hello.txt" }, undefined, undefined, ctx);
  assert.equal(routed.isError, true);
  assert.match(routed.content[0].text, /No workspace is active/);
  // Sanity: the fixture workspace really was inactive here.
  assert.equal(ws.name, "demo");
});
