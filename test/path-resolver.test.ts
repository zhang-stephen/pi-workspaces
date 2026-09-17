// Unit tests for src/path-resolver.ts. The resolver is pure (no IO), so
// tests use synthetic paths under the OS temp dir; no fixtures needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  isInside,
  owningRoot,
  resolveWorkspacePath,
  type RootInfo,
  type WorkspaceInfo,
} from "../src/path-resolver.ts";

const BASE = path.join(os.tmpdir(), "pi-workspaces-resolver-test");

function root(name: string, rel: string, exists = true): RootInfo {
  return { name, path: path.join(BASE, rel), exists };
}

function workspace(roots: RootInfo[], primary = roots[0].name): WorkspaceInfo {
  return { name: "demo", roots, primary, origin: "project" };
}

const ALPHA = root("alpha", "alpha");
const BETA = root("beta", "beta");
const WS = workspace([ALPHA, BETA]);
const SESSION = path.join(BASE, "session");

test("bare relative path resolves against session cwd", () => {
  const result = resolveWorkspacePath("src/a.ts", WS, SESSION);
  assert.deepEqual(result, {
    ok: true,
    absolutePath: path.join(SESSION, "src", "a.ts"),
    root: null,
  });
});

test("@root path resolves inside the named root", () => {
  const hit = resolveWorkspacePath("@alpha/src/a.ts", WS, SESSION);
  assert.deepEqual(hit, { ok: true, absolutePath: path.join(ALPHA.path, "src", "a.ts"), root: ALPHA });
  // "@root" with an empty path part resolves to the root dir itself
  const bare = resolveWorkspacePath("@alpha", WS, SESSION);
  assert.deepEqual(bare, { ok: true, absolutePath: ALPHA.path, root: ALPHA });
  const trailing = resolveWorkspacePath("@alpha/", WS, SESSION);
  assert.deepEqual(trailing, { ok: true, absolutePath: ALPHA.path, root: ALPHA });
});

test("unknown root errors and lists all available root names", () => {
  const result = resolveWorkspacePath("@gamma/a.ts", WS, SESSION);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /gamma/);
    assert.match(result.error, /alpha/);
    assert.match(result.error, /beta/);
  }
});

test("missing root errors as unavailable", () => {
  const ghost = root("ghost", "ghost", false);
  const ws = workspace([ghost, BETA]);
  const result = resolveWorkspacePath("@ghost/a.ts", ws, SESSION);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unavailable/);
    assert.match(result.error, /ghost/);
  }
});

test("path escaping the root via .. is rejected", () => {
  for (const input of ["@alpha/../outside.txt", "@alpha/../../outside.txt", "@alpha/../beta/x.ts"]) {
    const result = resolveWorkspacePath(input, WS, SESSION);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /escapes root/);
    }
  }
});

test("@root path without an active workspace errors", () => {
  const result = resolveWorkspacePath("@alpha/a.ts", null, SESSION);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /No workspace is active/);
  }
});

test("absolute path is attributed to its owning root", () => {
  const target = path.join(ALPHA.path, "src", "a.ts");
  const result = resolveWorkspacePath(target, WS, SESSION);
  assert.deepEqual(result, { ok: true, absolutePath: target, root: ALPHA });
});

test("absolute path outside all roots passes through with root null", () => {
  const target = path.join(os.tmpdir(), "pi-workspaces-elsewhere", "file.txt");
  const result = resolveWorkspacePath(target, WS, SESSION);
  assert.deepEqual(result, { ok: true, absolutePath: target, root: null });
});

test("nested roots: longest matching prefix wins", () => {
  const outer = root("outer", "outer");
  const inner = root("inner", path.join("outer", "inner"));
  const ws = workspace([outer, inner]);
  const target = path.join(inner.path, "file.txt");
  assert.equal(owningRoot(ws, target), inner);
  const result = resolveWorkspacePath(target, ws, SESSION);
  assert.deepEqual(result, { ok: true, absolutePath: target, root: inner });
});

test("isInside: a directory contains itself and its children", () => {
  const dir = path.join(BASE, "alpha");
  assert.equal(isInside(dir, dir), true);
  assert.equal(isInside(dir, path.join(dir, "src")), true);
  assert.equal(isInside(dir, path.join(dir, "src", "a.ts")), true);
});

test("isInside: siblings and prefix lookalikes are not inside", () => {
  const dir = path.join(BASE, "alpha");
  assert.equal(isInside(dir, path.join(BASE, "beta")), false);
  assert.equal(isInside(dir, path.join(BASE, "alpha-sibling")), false);
});

test("win32: drive letters compare case-insensitively, separators normalize", () => {
  assert.equal(isInside("C:\\ws\\alpha", "c:\\ws\\alpha\\file.txt"), true);
  assert.equal(isInside("C:/ws/alpha", "C:\\ws\\alpha\\file.txt"), true);
  assert.equal(isInside("C:\\ws\\alpha", "D:\\ws\\alpha\\file.txt"), false);
});
