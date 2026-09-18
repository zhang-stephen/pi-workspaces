// Unit tests for src/workspace-store.ts (definition validation, dual-source
// merge-by-name, flat config resolution). All pure functions, no IO, so
// tests use synthetic definitions with paths that never touch the filesystem.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_DEFAULTS,
  mergeByName,
  resolveConfig,
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

// D9 (simplified): no dedicated legacy-key detection. The schema is
// name/version/roots only - stale 'primary', the removed 'options' object,
// and legacy option keys all fail the generic unknown-key rejection.
// Definitions are migrated by hand; invalid files are skipped silently at
// session_start and surface via /workspace list (2026-09-19 spec D1).
test("unknown top-level keys are rejected with the key named", () => {
  for (const key of ["primary", "options", "autoLoadInPrimary", "promptInOtherDirs"]) {
    const result = validateDefinition({ ...VALID, [key]: "app" });
    assert.equal(result.ok, false, key);
    if (!result.ok) {
      assert.match(result.error, /unknown workspace definition key/i);
      assert.ok(result.error.includes(`'${key}'`), `error names '${key}': ${result.error}`);
    }
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

  const { merged, shadowed, collisions } = mergeByName(
    [globalOnly, sharedGlobal],
    [sharedProject, projectOnly],
  );

  assert.deepEqual(collisions, ["shared"]);
  // The losing global copy is retained as shadowed for relevance-gated
  // collision notices (2026-09-19 spec, D2).
  assert.deepEqual(shadowed.map((s) => [s.def.name, s.origin] as const), [["shared", "global"]]);
  assert.equal(shadowed[0].def, sharedGlobal);
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

test("resolveConfig: project > global > builtin, per key", () => {
  assert.deepEqual(BUILTIN_DEFAULTS, { activation: "auto", warnOnUnrelatedLoad: true, projectRootAscend: 3 });

  // Level 1: the project file wins over the global config.
  assert.deepEqual(
    resolveConfig(
      { activation: "prompt", warnOnUnrelatedLoad: false },
      { activation: "auto", warnOnUnrelatedLoad: true },
    ),
    { activation: "prompt", warnOnUnrelatedLoad: false, projectRootAscend: 3 },
  );

  // Level 2: keys the project file leaves unset fall through to the
  // global config, per key.
  assert.deepEqual(
    resolveConfig({ activation: "prompt" }, { activation: "auto", warnOnUnrelatedLoad: false, projectRootAscend: 5 }),
    { activation: "prompt", warnOnUnrelatedLoad: false, projectRootAscend: 5 },
  );

  // Level 3: keys missing everywhere fall through to the builtin defaults.
  assert.deepEqual(resolveConfig({}, {}), {
    activation: "auto",
    warnOnUnrelatedLoad: true,
    projectRootAscend: 3,
  });

  // projectRootAscend is a global-only knob: a project-level value is
  // ignored even when present in the partial (2026-09-19 spec, D4).
  assert.equal(resolveConfig({ projectRootAscend: 9 }, {}).projectRootAscend, 3);
  assert.equal(resolveConfig({ projectRootAscend: 9 }, { projectRootAscend: 5 }).projectRootAscend, 5);
});
