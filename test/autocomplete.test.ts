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

test("completeRootNames offers switchers labeled name/ with absolute-path descriptions", () => {
  const ws: WorkspaceInfo = {
    name: "demo",
    origin: "project",
    roots: [
      { name: "alpha", path: "/ws/alpha", exists: true },
      { name: "alpine", path: "/ws/alpine", exists: true },
      { name: "beta", path: "/ws/beta", exists: true },
    ],
  };
  assert.deepEqual(completeRootNames(ws, "al"), [
    { label: "alpha/", description: "/ws/alpha" },
    { label: "alpine/", description: "/ws/alpine" },
  ]);
  assert.deepEqual(completeRootNames(ws, ""), [
    { label: "alpha/", description: "/ws/alpha" },
    { label: "alpine/", description: "/ws/alpine" },
    { label: "beta/", description: "/ws/beta" },
  ]);
  assert.deepEqual(completeRootNames(ws, "zzz"), []);
  // Case-insensitive prefix, following pi's own completion convention.
  assert.deepEqual(completeRootNames(ws, "AL"), [
    { label: "alpha/", description: "/ws/alpha" },
    { label: "alpine/", description: "/ws/alpine" },
  ]);
});

test("completeInRoot lists entries, skips node_modules/.git, caps at 50", () => {
  const root = makeFixtureRoot();
  try {
    // Listing: directories get a "/" suffix, everything is sorted by name,
    // and each item describes its path relative to the root.
    assert.deepEqual(completeInRoot(root, ""), [
      { label: "many/", description: "many" },
      { label: "src/", description: "src" },
      { label: "zeta.txt", description: "zeta.txt" },
    ]);
    // The fragment filters within the last path segment only;
    // case-insensitive, following pi's own completion convention.
    assert.deepEqual(completeInRoot(root, "S"), [{ label: "src/", description: "src" }]);
    assert.deepEqual(completeInRoot(root, "src/UT"), [{ label: "utils/", description: "src/utils" }]);
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
    assert.deepEqual(capped[0], { label: "file_00.txt", description: "many/file_00.txt" });
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("createAutocompleteProvider delegates quoted @-mentions to the built-in provider", async () => {
  // '@"doc' is a quoted file attachment, not @root syntax: the built-in
  // provider's fuzzy file matching must see it untouched.
  const marker = { items: [{ value: "doc.pdf", label: "doc.pdf" }], prefix: "@\"doc" };
  const current = makeStubCurrent(marker);
  const provider = createAutocompleteProvider(() => makeWorkspace(), "/unrelated")(current as never);
  const result = await provider.getSuggestions(["@\"doc"], 0, 5, { signal: new AbortController().signal });
  assert.equal(result, marker);
  assert.equal(current.calls, 1);
});

test("createAutocompleteProvider delegates when no workspace is active", async () => {
  const marker = { items: [{ value: "@anything", label: "@anything" }], prefix: "@a" };
  const current = makeStubCurrent(marker);
  const provider = createAutocompleteProvider(() => null, "/unrelated")(current as never);
  const result = await provider.getSuggestions(["@a"], 0, 2, { signal: new AbortController().signal });
  assert.equal(result, marker);
  assert.equal(current.calls, 1);
});

test("createAutocompleteProvider returns empty items for root-less paths without a current root", async () => {
  const marker = { items: [{ value: "stub", label: "stub" }], prefix: "stub" };
  const current = makeStubCurrent(marker);
  // The cwd is outside every root, so "@zzz/x" (zzz is no root name) is a
  // root-less path with no current root: nothing to offer, no delegation.
  const provider = createAutocompleteProvider(() => makeWorkspace(), "/unrelated")(current as never);
  const result = await provider.getSuggestions(["@zzz/x"], 0, 6, { signal: new AbortController().signal });
  assert.deepEqual(result, { items: [], prefix: "@zzz/x" });
  assert.equal(current.calls, 0);
});

test("provider offers switchers plus current-root entries on a bare @", async () => {
  const alpha = makeFixtureRoot();
  try {
    const ws: WorkspaceInfo = {
      name: "demo",
      origin: "project",
      roots: [alpha, { name: "beta", path: "/ws/beta", exists: true }],
    };
    const sessionCwd = path.join(alpha.path, "src"); // inside alpha
    const provider = createAutocompleteProvider(() => ws, sessionCwd)(makeStubCurrent(null) as never);
    const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });

    // Switchers first: bare "name/" labels, "@name/" values, absolute-path
    // descriptions.
    assert.deepEqual(result.items[0], { value: "@alpha/", label: "alpha/", description: alpha.path });
    assert.deepEqual(result.items[1], { value: "@beta/", label: "beta/", description: "/ws/beta" });
    // Then the current root's top-level entries with explicit values.
    assert.deepEqual(result.items.slice(2), [
      { value: "@alpha/many/", label: "many/", description: "many" },
      { value: "@alpha/src/", label: "src/", description: "src" },
      { value: "@alpha/zeta.txt", label: "zeta.txt", description: "zeta.txt" },
    ]);
    assert.equal(result.prefix, "@");
  } finally {
    fs.rmSync(alpha.path, { recursive: true, force: true });
  }
});

test("provider offers switchers only when the cwd is inside no root", async () => {
  const ws = makeWorkspace();
  const provider = createAutocompleteProvider(() => ws, "/unrelated")(makeStubCurrent(null) as never);
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assert.deepEqual(result.items, [{ value: "@alpha/", label: "alpha/", description: "/ws/alpha" }]);
});

test("provider completes root-less paths inside the current root", async () => {
  const alpha = makeFixtureRoot();
  try {
    const ws: WorkspaceInfo = { name: "demo", origin: "project", roots: [alpha] };
    const provider = createAutocompleteProvider(() => ws, alpha.path)(makeStubCurrent(null) as never);

    // "@src/ut": src is not a root name, so the token is a path inside the
    // current root - the value is rewritten to the explicit form (A4).
    const result = await provider.getSuggestions(["@src/ut"], 0, 7, { signal: new AbortController().signal });
    assert.deepEqual(result.items, [{ value: "@alpha/src/utils/", label: "utils/", description: "src/utils" }]);
    assert.equal(result.prefix, "@src/ut");

    // "@s": slash-free token - switchers (none match) plus the current
    // root's matching top-level entries.
    const single = await provider.getSuggestions(["@s"], 0, 2, { signal: new AbortController().signal });
    assert.deepEqual(single.items, [{ value: "@alpha/src/", label: "src/", description: "src" }]);
  } finally {
    fs.rmSync(alpha.path, { recursive: true, force: true });
  }
});

test("provider keeps the explicit-root drill-down behavior unchanged", async () => {
  const alpha = makeFixtureRoot();
  try {
    const ws: WorkspaceInfo = { name: "demo", origin: "project", roots: [alpha] };
    const provider = createAutocompleteProvider(() => ws, "/unrelated")(makeStubCurrent(null) as never);
    const result = await provider.getSuggestions(["@alpha/src/ut"], 0, 13, { signal: new AbortController().signal });
    assert.deepEqual(result.items, [{ value: "@alpha/src/utils/", label: "utils/", description: "src/utils" }]);
    assert.equal(result.prefix, "@alpha/src/ut");
  } finally {
    fs.rmSync(alpha.path, { recursive: true, force: true });
  }
});

test("provider keeps both groups when a root name collides with a current-root entry (A7)", async () => {
  const alpha = makeFixtureRoot();
  try {
    // The workspace also has a root named "many"; the current root alpha
    // has a top-level directory "many/".
    const ws: WorkspaceInfo = {
      name: "demo",
      origin: "project",
      roots: [alpha, { name: "many", path: "/ws/many", exists: true }],
    };
    const provider = createAutocompleteProvider(() => ws, alpha.path)(makeStubCurrent(null) as never);
    const result = await provider.getSuggestions(["@ma"], 0, 3, { signal: new AbortController().signal });
    assert.deepEqual(result.items, [
      { value: "@many/", label: "many/", description: "/ws/many" },
      { value: "@alpha/many/", label: "many/", description: "many" },
    ]);
  } finally {
    fs.rmSync(alpha.path, { recursive: true, force: true });
  }
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
