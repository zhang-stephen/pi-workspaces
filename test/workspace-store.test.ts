// Unit tests for src/workspace-store.ts (definition validation, dual-source
// merge-by-name, three-level options chain). All pure functions, no IO, so
// tests use synthetic definitions with paths that never touch the filesystem.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_DEFAULTS,
  mergeByName,
  resolveOptions,
  validateDefinition,
  type WorkspaceDefinition,
} from "../src/workspace-store.ts";

const VALID: WorkspaceDefinition = {
  name: "demo",
  version: 1,
  roots: [
    { name: "app", path: "/ws/app" },
    { name: "docs", path: "/ws/docs" },
  ],
};

test("valid definition passes validation", () => {
  const minimal = validateDefinition(VALID);
  assert.deepEqual(minimal, { ok: true, def: VALID });

  const withOptions = validateDefinition({
    ...VALID,
    options: { activation: "prompt", warnOnUnrelatedLoad: false },
  });
  assert.deepEqual(withOptions, {
    ok: true,
    def: { ...VALID, options: { activation: "prompt", warnOnUnrelatedLoad: false } },
  });
});

test("unknown version is rejected", () => {
  for (const version of [0, 2, 999, "1", null, undefined]) {
    const result = validateDefinition({ ...VALID, version });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /version/i);
    }
  }
});

test("illegal workspace/root names are rejected", () => {
  // The name pattern is /^[A-Za-z0-9_-]+$/; anything else must fail.
  for (const bad of ["", "my ws", "my/ws", "my.ws", "my@ws"]) {
    const workspace = validateDefinition({ ...VALID, name: bad });
    assert.equal(workspace.ok, false);
    if (!workspace.ok) {
      assert.match(workspace.error, /workspace name/i);
    }
    const root = validateDefinition({
      ...VALID,
      roots: [{ name: bad, path: "/ws/app" }],
    });
    assert.equal(root.ok, false);
    if (!root.ok) {
      assert.match(root.error, /root name/i);
    }
  }
});

test("duplicate root names are rejected", () => {
  const result = validateDefinition({
    ...VALID,
    roots: [
      { name: "app", path: "/ws/a" },
      { name: "docs", path: "/ws/d" },
      { name: "app", path: "/ws/a-copy" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /duplicate root name/i);
    assert.match(result.error, /app/);
  }
});

test("empty roots are rejected", () => {
  const empty = validateDefinition({ ...VALID, roots: [] });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.error, /non-empty/);
  }
});

// D9 (simplified): no dedicated legacy-key detection. A stale 'primary'
// field is simply not part of the schema anymore; legacy option keys hit
// the generic unknown-option rejection below. Definitions are migrated by
// hand.
test("a stale 'primary' field is no longer part of the schema", () => {
  const result = validateDefinition({ ...VALID, primary: "app" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal("primary" in result.def, false, "the normalized copy drops it");
  }
});

test("legacy option keys fail the generic unknown-option check", () => {
  for (const key of ["autoLoadInPrimary", "promptInOtherDirs"]) {
    const result = validateDefinition({ ...VALID, options: { [key]: true } });
    assert.equal(result.ok, false, key);
    if (!result.ok) {
      assert.match(result.error, /unknown workspace option/i);
      assert.ok(result.error.includes(`'${key}'`), `error names '${key}': ${result.error}`);
    }
  }
});

test("option values are type-checked; unknown options are rejected", () => {
  const badActivation = validateDefinition({ ...VALID, options: { activation: "sometimes" } });
  assert.equal(badActivation.ok, false);
  if (!badActivation.ok) {
    assert.match(badActivation.error, /activation/);
  }

  const badWarn = validateDefinition({ ...VALID, options: { warnOnUnrelatedLoad: "yes" } });
  assert.equal(badWarn.ok, false);
  if (!badWarn.ok) {
    assert.match(badWarn.error, /warnOnUnrelatedLoad/);
  }

  const unknown = validateDefinition({ ...VALID, options: { nope: true } });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.match(unknown.error, /unknown workspace option/i);
    assert.match(unknown.error, /nope/);
  }
});

test("mergeByName: project wins, global-only names survive, collisions reported", () => {
  const globalOnly: WorkspaceDefinition = { ...VALID, name: "global-only" };
  const sharedGlobal: WorkspaceDefinition = { ...VALID, name: "shared" };
  const sharedProject: WorkspaceDefinition = {
    ...VALID,
    name: "shared",
    roots: [{ name: "docs", path: "/ws/docs" }],
  };
  const projectOnly: WorkspaceDefinition = { ...VALID, name: "project-only" };

  const { merged, collisions } = mergeByName(
    [globalOnly, sharedGlobal],
    [sharedProject, projectOnly],
  );

  assert.deepEqual(collisions, ["shared"]);
  assert.deepEqual(
    merged.map((m) => [m.def.name, m.origin] as const),
    [
      ["global-only", "global"],
      ["shared", "project"],
      ["project-only", "project"],
    ],
  );
  // The project definition object replaces the global one verbatim.
  assert.equal(merged.find((m) => m.def.name === "shared")?.def, sharedProject);
});

test("resolveOptions: workspace > defaults > builtin, per key", () => {
  assert.deepEqual(BUILTIN_DEFAULTS, { activation: "auto", warnOnUnrelatedLoad: true, projectRootAscend: 3 });

  // Level 1: a workspace option wins over the defaults.
  const overridden: WorkspaceDefinition = {
    ...VALID,
    options: { activation: "prompt" },
  };
  assert.deepEqual(
    resolveOptions(overridden, { activation: "auto", warnOnUnrelatedLoad: false }),
    { activation: "prompt", warnOnUnrelatedLoad: false },
  );

  // Level 2: keys the workspace leaves unset fall through to the defaults.
  assert.deepEqual(
    resolveOptions(VALID, { activation: "prompt", warnOnUnrelatedLoad: false }),
    { activation: "prompt", warnOnUnrelatedLoad: false },
  );

  // Level 3: keys missing from the defaults fall through to the builtin
  // defaults (simulated sparse defaults; real callers pass a loaded config).
  assert.deepEqual(resolveOptions(VALID, { warnOnUnrelatedLoad: false }), {
    activation: "auto",
    warnOnUnrelatedLoad: false,
  });
});
