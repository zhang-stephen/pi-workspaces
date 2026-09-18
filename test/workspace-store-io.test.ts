// Unit tests for src/workspace-store.ts part 2: project-source discovery by
// marker ascent (D5), definition-file IO (source scan, atomic save), root
// health checks, root add/remove operations, and dual-source loadAll.
// Fixtures live in temp dirs; the global source is isolated by pointing
// PI_CODING_AGENT_DIR at an empty temp dir (getAgentDir reads that env var
// at call time).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addRoot,
  DEFAULT_PROJECT_ROOT_ASCEND,
  discoverProjectDir,
  globalConfigFile,
  globalWorkspacesDir,
  loadAll,
  loadGlobalConfig,
  loadProjectConfig,
  projectConfigFile,
  projectWorkspacesDir,
  removeRoot,
  resolveConfig,
  saveDefinition,
  scanSource,
  toWorkspaceInfo,
  type WorkspaceDefinition,
} from "../src/workspace-store.ts";
import { isInside } from "../src/path-resolver.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

const DEF: WorkspaceDefinition = {
  name: "demo",
  version: 1,
  roots: [{ name: "app", path: "/ws/app" }],
};

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test("scanSource keeps valid files and skips corrupt/bad-version ones with warnings", () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, "good.json", JSON.stringify(DEF));
    writeFile(dir, "corrupt.json", "{ not json");
    writeFile(dir, "badver.json", JSON.stringify({ ...DEF, name: "badver", version: 2 }));
    writeFile(dir, "notes.txt", "not a definition; must be ignored");

    const { defs, warnings } = scanSource(dir, "project");

    assert.deepEqual(defs, [DEF]);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes("corrupt.json") && /corrupt/i.test(w)));
    assert.ok(warnings.some((w) => w.includes("badver.json") && /version/i.test(w)));
  } finally {
    cleanup(dir);
  }
});

// D9 (simplified): no dedicated legacy-key detection - the schema is
// name/version/roots only, so a stale 'primary' field and the removed
// 'options' object both fail the generic unknown-key check and the file is
// skipped with a warning (silent at session_start per D1; visible here).
test("scanSource skips definitions carrying unknown top-level keys, with a warning", () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, "legacy-primary.json", JSON.stringify({ ...DEF, primary: "app" }));
    writeFile(dir, "legacy-options.json", JSON.stringify({ ...DEF, options: { activation: "prompt" } }));

    const { defs, warnings } = scanSource(dir, "project");

    assert.deepEqual(defs, [], "no definition with unknown top-level keys loads");
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes("legacy-primary.json") && w.includes("'primary'")));
    assert.ok(warnings.some((w) => w.includes("legacy-options.json") && w.includes("'options'")));
  } finally {
    cleanup(dir);
  }
});

test("scanSource of a missing directory yields empty results without warnings", () => {
  const dir = path.join(makeTempDir(), "does-not-exist");
  assert.deepEqual(scanSource(dir, "global"), { defs: [], warnings: [] });
});

// Flat plugin config (2026-09-19 spec, D4): builtin < global < project,
// per key, tolerant reader; projectRootAscend is a global-only knob.
test("loadGlobalConfig reads the flat file per key and tolerates any problem", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const agentDir = makeTempDir("pi-workspaces-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Missing file: every key unset.
    assert.deepEqual(loadGlobalConfig(), {});
    assert.equal(globalConfigFile(), path.join(agentDir, "pi-workspaces.json"));

    writeFile(agentDir, "pi-workspaces.json", JSON.stringify({
      activation: "prompt",
      warnOnUnrelatedLoad: false,
      projectRootAscend: 5,
      unknownKey: "ignored",
    }));
    assert.deepEqual(loadGlobalConfig(), {
      activation: "prompt",
      warnOnUnrelatedLoad: false,
      projectRootAscend: 5,
    });

    // Wrongly typed values degrade to "unset"; the legacy 'defaults'
    // wrapper is just an unknown key now; a negative cap is not a cap.
    writeFile(agentDir, "pi-workspaces.json", JSON.stringify({
      defaults: { activation: "prompt" },
      activation: "sometimes",
      warnOnUnrelatedLoad: "yes",
      projectRootAscend: -1,
    }));
    assert.deepEqual(loadGlobalConfig(), {});
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir);
  }
});

test("loadProjectConfig reads <projectRoot>/.pi/pi-workspaces.json and never the ascend cap", () => {
  const projectDir = makeTempDir("pi-workspaces-proj-");
  try {
    assert.deepEqual(loadProjectConfig(projectDir), {}, "a missing file yields an empty partial");

    writeFile(projectDir, path.join(".pi", "pi-workspaces.json"), JSON.stringify({
      activation: "prompt",
      warnOnUnrelatedLoad: false,
      projectRootAscend: 9,
    }));
    // The ascend cap is not even read at the project level (D4).
    assert.deepEqual(loadProjectConfig(projectDir), {
      activation: "prompt",
      warnOnUnrelatedLoad: false,
    });
    assert.equal(projectConfigFile(projectDir), path.join(projectDir, ".pi", "pi-workspaces.json"));
  } finally {
    cleanup(projectDir);
  }
});

test("discoverProjectDir stops at the nearest marker when starting in a subdirectory", () => {
  const dir = makeTempDir();
  try {
    // Project root carries a .git marker; the session starts two levels below.
    fs.mkdirSync(path.join(dir, ".git"));
    const sub = path.join(dir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });

    assert.equal(discoverProjectDir(sub), dir);
    assert.equal(projectWorkspacesDir(sub), path.join(dir, ".pi", "workspaces"));
    // The cwd itself is checked first (level 0).
    assert.equal(discoverProjectDir(dir), dir);
  } finally {
    cleanup(dir);
  }
});

test("discoverProjectDir: any of the markers (.pi/.git/.agents) qualifies", () => {
  const dir = makeTempDir();
  try {
    for (const marker of [".pi", ".git", ".agents"]) {
      const base = path.join(dir, marker.slice(1));
      const sub = path.join(base, "sub");
      fs.mkdirSync(path.join(base, marker), { recursive: true });
      fs.mkdirSync(sub, { recursive: true });
      assert.equal(discoverProjectDir(sub), base, marker);
    }
  } finally {
    cleanup(dir);
  }
});

test("discoverProjectDir falls back to the cwd when no ancestor within the cap has a marker", () => {
  const dir = makeTempDir();
  try {
    const start = path.join(dir, "a", "b");
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    // ascend 0: only the cwd itself is checked.
    assert.equal(discoverProjectDir(start, 0), start);
    // ascend 1: the parent has no marker either -> the cwd itself wins.
    assert.equal(discoverProjectDir(start, 1), start);
  } finally {
    cleanup(dir);
  }
});

test("discoverProjectDir honors the ascent cap", () => {
  const dir = makeTempDir();
  try {
    // Marker sits three levels above the start directory.
    fs.mkdirSync(path.join(dir, ".git"));
    const start = path.join(dir, "a", "b", "c");
    fs.mkdirSync(start, { recursive: true });

    assert.equal(discoverProjectDir(start, 3), dir, "within the cap: marker dir wins");
    assert.equal(discoverProjectDir(start, 2), start, "cap hit: falls back to the cwd");
  } finally {
    cleanup(dir);
  }
});

test("discoverProjectDir never ascends above the home directory", () => {
  const home = os.homedir();
  const base = fs.mkdtempSync(path.join(home, "pi-workspaces-hometest-"));
  try {
    const start = path.join(base, "a", "b", "c");
    fs.mkdirSync(start, { recursive: true });
    // A generous cap would reach above home without the guard; the result
    // must stay at or below home (home itself is still checked - it holds
    // the ~/.pi agent directory on real installs).
    const discovered = discoverProjectDir(start, 50);
    assert.ok(
      discovered === home || isInside(home, discovered),
      `must not escape home: ${discovered}`,
    );
    assert.ok(isInside(base, discovered) || discovered === home || discovered === start);
  } finally {
    cleanup(base);
  }
});

test("loadAll discovers the project source by marker ascent from a subdirectory", () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const dir = makeTempDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // The project root is two levels above the session cwd; only the root
    // carries definitions and the .git marker.
    fs.mkdirSync(path.join(dir, ".git"));
    writeFile(dir, path.join(".pi", "workspaces", "proj.json"), JSON.stringify(DEF));
    const sub = path.join(dir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });

    const { merged, projectDir } = loadAll(sub, "project");

    assert.equal(projectDir, path.join(dir, ".pi", "workspaces"));
    assert.deepEqual(merged.map((m) => [m.def.name, m.origin] as const), [["demo", "project"]]);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, dir);
  }
});

// D5: the nearest marker directory wins even without .pi/workspaces - the
// project source is empty and there is no further ascent into outer projects.
test("loadAll: a nearer marker without definitions shadows outer projects", () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const outer = makeTempDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Outer project: marker + definitions.
    fs.mkdirSync(path.join(outer, ".git"));
    writeFile(outer, path.join(".pi", "workspaces", "outer.json"), JSON.stringify({ ...DEF, name: "outer" }));
    // Inner project: marker only, no .pi/workspaces.
    const inner = path.join(outer, "packages", "inner");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });

    const { merged, projectDir } = loadAll(inner, "project");

    assert.equal(projectDir, path.join(inner, ".pi", "workspaces"));
    assert.deepEqual(merged, [], "the outer project's definitions stay invisible");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, outer);
  }
});

test("saveDefinition writes atomically and round-trips through scanSource", async () => {
  const dir = makeTempDir();
  try {
    await saveDefinition(dir, DEF);

    const target = path.join(dir, "demo.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), DEF);
    // Atomic write: no temp file may survive next to the target.
    assert.equal(fs.existsSync(`${target}.tmp`), false);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);

    const { defs, warnings } = scanSource(dir, "project");
    assert.deepEqual(defs, [DEF]);
    assert.deepEqual(warnings, []);
  } finally {
    cleanup(dir);
  }
});

test("toWorkspaceInfo realpaths existing roots and flags missing ones without throwing", () => {
  const dir = makeTempDir();
  try {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    const missing = path.join(dir, "gone");
    const def: WorkspaceDefinition = {
      name: "health",
      version: 1,
      roots: [
        // Non-canonical spelling of an existing dir; the health check must
        // canonicalize it via realpath.
        { name: "ok", path: path.join(dir, "sub", "..", "real") },
        { name: "gone", path: missing },
      ],
    };

    const info = toWorkspaceInfo(def, "project");

    assert.equal(info.name, "health");
    assert.equal(info.origin, "project");
    const ok = info.roots.find((r) => r.name === "ok");
    const gone = info.roots.find((r) => r.name === "gone");
    assert.equal(ok?.exists, true);
    assert.equal(ok?.path, fs.realpathSync(real));
    assert.equal(gone?.exists, false);
    assert.equal(gone?.path, missing);
  } finally {
    cleanup(dir);
  }
});

test("addRoot defaults the name to basename and rejects duplicates/illegal names", () => {
  const def: WorkspaceDefinition = {
    ...DEF,
    roots: [
      { name: "app", path: "/ws/app" },
      { name: "docs", path: "/ws/docs" },
    ],
  };
  const added = addRoot(def, null, path.join("ws", "frontend"));
  assert.deepEqual(added.roots, [
    { name: "app", path: "/ws/app" },
    { name: "docs", path: "/ws/docs" },
    { name: "frontend", path: path.join("ws", "frontend") },
  ]);
  assert.equal(def.roots.length, 2); // input is not mutated

  assert.throws(() => addRoot(def, "app", "/ws/other"), /duplicate root name/i);
  assert.throws(() => addRoot(def, "bad name", "/ws/x"), /root name/i);
  assert.throws(() => addRoot(def, null, ""), /non-empty/i);
});

test("removeRoot drops a root and refuses unknown names and the last root (D8)", () => {
  const def: WorkspaceDefinition = {
    ...DEF,
    roots: [
      { name: "app", path: "/ws/app" },
      { name: "docs", path: "/ws/docs" },
    ],
  };
  const removed = removeRoot(def, "docs");
  assert.deepEqual(removed.roots, [{ name: "app", path: "/ws/app" }]);
  assert.equal(def.roots.length, 2); // input is not mutated

  // The last remaining root is protected.
  assert.throws(() => removeRoot(removed, "app"), /last root/i);
  assert.throws(() => removeRoot(def, "ghost"), /unknown root/i);
});

test("loadAll merges both sources with the project source winning per name", () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.equal(globalWorkspacesDir(), path.join(agentDir, "workspaces"));

    const globalDef: WorkspaceDefinition = { ...DEF, name: "shared" };
    const projectDef: WorkspaceDefinition = { ...DEF, name: "shared",
      roots: [
        { name: "app", path: "/ws/app" },
        { name: "docs", path: "/ws/docs" },
      ],
    };
    const projectOnly: WorkspaceDefinition = { ...DEF, name: "project-only" };
    writeFile(agentDir, path.join("workspaces", "shared.json"), JSON.stringify(globalDef));
    writeFile(agentDir, path.join("workspaces", "global-only.json"), JSON.stringify({ ...DEF, name: "global-only" }));
    // Writing the project definitions first also creates the cwd's .pi
    // marker, so discovery stops at the cwd itself.
    writeFile(cwd, path.join(".pi", "workspaces", "shared.json"), JSON.stringify(projectDef));
    writeFile(cwd, path.join(".pi", "workspaces", "project-only.json"), JSON.stringify(projectOnly));
    assert.equal(projectWorkspacesDir(cwd), path.join(cwd, ".pi", "workspaces"));

    const { merged, collisions, warnings, projectDir } = loadAll(cwd, "global");

    assert.equal(projectDir, path.join(cwd, ".pi", "workspaces"));
    assert.deepEqual(warnings, []);
    assert.deepEqual(collisions, ["shared"]);
    assert.deepEqual(
      merged.map((m) => [m.def.name, m.origin] as const),
      [
        // Global entries keep source (sorted) order, with the project copy
        // of "shared" replacing the global one in place; project-only names
        // are appended in project order.
        ["global-only", "global"],
        ["shared", "project"],
        ["project-only", "project"],
      ],
    );
    // The project definition content replaced the global one (scanSource
    // normalizes, so compare by value, not identity).
    assert.deepEqual(merged.find((m) => m.def.name === "shared")?.def, projectDef);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("loadAll in project scope scans only the project source", () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(agentDir, path.join("workspaces", "global-only.json"), JSON.stringify({ ...DEF, name: "global-only" }));
    writeFile(cwd, path.join(".pi", "workspaces", "proj.json"), JSON.stringify({ ...DEF, name: "proj" }));

    const { merged, collisions, warnings } = loadAll(cwd, "project");

    // The global definition stays invisible: no merge, no collision, and
    // no warning can reference it.
    assert.deepEqual(merged.map((m) => [m.def.name, m.origin] as const), [["proj", "project"]]);
    assert.deepEqual(collisions, []);
    assert.deepEqual(warnings, []);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

// The default ascent cap exists so a stray cwd cannot wander arbitrarily
// far up the tree looking for markers.
test("DEFAULT_PROJECT_ROOT_ASCEND is the built-in cap", () => {
  assert.equal(DEFAULT_PROJECT_ROOT_ASCEND, 3);
});
