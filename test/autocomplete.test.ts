// Unit tests for src/autocomplete.ts: @token parsing plus root-name and
// in-root path completion. completeInRoot runs against a temp fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAtToken, completeRootNames, completeInRoot, createAutocompleteProvider } from "../src/autocomplete.ts";
import type { RootInfo, WorkspaceInfo } from "../src/path-resolver.ts";

test("parseAtToken extracts @tokens only at line start or after whitespace", () => {
  // Line-start triggers: bare prefix, path part, trailing separator.
  assert.deepEqual(parseAtToken("@al"), { rootPart: "al", pathPart: null });
  assert.deepEqual(parseAtToken("@alpha/src/ap"), { rootPart: "alpha", pathPart: "src/ap" });
  assert.deepEqual(parseAtToken("@alpha/"), { rootPart: "alpha", pathPart: "" });
  // After whitespace, including mid-line.
  assert.deepEqual(parseAtToken("show @beta/x.ts"), { rootPart: "beta", pathPart: "x.ts" });
  assert.deepEqual(parseAtToken("\t@gamma"), { rootPart: "gamma", pathPart: null });
  // Email-like text must NOT trigger: the @ is not at a token boundary.
  assert.equal(parseAtToken("a@b.com"), null);
  assert.equal(parseAtToken("ping a@b about it"), null);
  // No @ at all.
  assert.equal(parseAtToken("plain text"), null);
  assert.equal(parseAtToken(""), null);
});

test("completeRootNames filters roots by prefix and labels them @name", () => {
  const ws: WorkspaceInfo = {
    name: "demo",
    origin: "project",
    roots: [
      { name: "alpha", path: "/ws/alpha", exists: true },
      { name: "alpine", path: "/ws/alpine", exists: true },
      { name: "beta", path: "/ws/beta", exists: true },
    ],
  };
  assert.deepEqual(completeRootNames(ws, "al"), [{ label: "@alpha" }, { label: "@alpine" }]);
  assert.deepEqual(completeRootNames(ws, ""), [{ label: "@alpha" }, { label: "@alpine" }, { label: "@beta" }]);
  assert.deepEqual(completeRootNames(ws, "zzz"), []);
});

test("completeInRoot lists entries, skips node_modules/.git, caps at 50", () => {
  const root = makeFixtureRoot();
  try {
    // Listing: directories get a "/" suffix, everything is sorted by name.
    assert.deepEqual(completeInRoot(root, ""), [
      { label: "many/" },
      { label: "src/" },
      { label: "zeta.txt" },
    ]);
    // The fragment filters within the last path segment only.
    assert.deepEqual(completeInRoot(root, "s"), [{ label: "src/" }]);
    assert.deepEqual(completeInRoot(root, "src/ut"), [{ label: "utils/" }]);
    // node_modules and .git never appear.
    const top = completeInRoot(root, "").map((item) => item.label);
    assert.ok(!top.includes("node_modules/"));
    assert.ok(!top.includes(".git/"));
    // Nonexistent directories return empty rather than throwing; ".."
    // segments that escape the root are refused outright.
    assert.deepEqual(completeInRoot(root, "nope/"), []);
    assert.deepEqual(completeInRoot(root, "nope/deeper/"), []);
    assert.deepEqual(completeInRoot(root, "../"), []);
    // The result is capped at 50 entries.
    const capped = completeInRoot(root, "many/");
    assert.equal(capped.length, 50);
    assert.deepEqual(capped[0], { label: "file_00.txt" });
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("createAutocompleteProvider delegates quoted @-mentions to the built-in provider", async () => {
  // '@"doc' is a quoted file attachment, not @root syntax: the built-in
  // provider's fuzzy file matching must see it untouched.
  const marker = { items: [{ value: "doc.pdf", label: "doc.pdf" }], prefix: "@\"doc" };
  const current = makeStubCurrent(marker);
  const provider = createAutocompleteProvider(() => makeWorkspace())(current as never);
  const result = await provider.getSuggestions(["@\"doc"], 0, 5, { signal: new AbortController().signal });
  assert.equal(result, marker);
  assert.equal(current.calls, 1);
});

test("createAutocompleteProvider delegates when no workspace is active", async () => {
  const marker = { items: [{ value: "@anything", label: "@anything" }], prefix: "@a" };
  const current = makeStubCurrent(marker);
  const provider = createAutocompleteProvider(() => null)(current as never);
  const result = await provider.getSuggestions(["@a"], 0, 2, { signal: new AbortController().signal });
  assert.equal(result, marker);
  assert.equal(current.calls, 1);
});

test("createAutocompleteProvider returns empty items for unknown roots in stage 2", async () => {
  const marker = { items: [{ value: "stub", label: "stub" }], prefix: "stub" };
  const current = makeStubCurrent(marker);
  const provider = createAutocompleteProvider(() => makeWorkspace())(current as never);
  const result = await provider.getSuggestions(["@zzz/x"], 0, 6, { signal: new AbortController().signal });
  // Empty items (no fuzzy fallthrough to the built-in layer), and no delegation.
  assert.deepEqual(result, { items: [], prefix: "@zzz/x" });
  assert.equal(current.calls, 0);
});

/** Minimal AutocompleteProviderOut stub: getSuggestions returns `marker`. */
function makeStubCurrent(marker: unknown): {
  getSuggestions: () => Promise<unknown>;
  applyCompletion: () => never;
  shouldTriggerFileCompletion: () => boolean;
  calls: number;
} {
  const stub = {
    calls: 0,
    getSuggestions: () => {
      stub.calls += 1;
      return Promise.resolve(marker);
    },
    applyCompletion: (): never => {
      throw new Error("applyCompletion should not be called in these tests");
    },
    shouldTriggerFileCompletion: () => true,
  };
  return stub;
}

/** Workspace fixture with one root for provider-level tests. */
function makeWorkspace(): WorkspaceInfo {
  return {
    name: "demo",
    origin: "project",
    roots: [{ name: "alpha", path: "/ws/alpha", exists: true }],
  };
}

/** Build a RootInfo over a fresh temp directory with known contents. */
function makeFixtureRoot(): RootInfo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workspaces-autocomplete-"));
  fs.mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "somepkg"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "zeta.txt"), "");
  fs.mkdirSync(path.join(dir, "many"));
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(dir, "many", `file_${String(i).padStart(2, "0")}.txt`), "");
  }
  return { name: "alpha", path: dir, exists: true };
}
