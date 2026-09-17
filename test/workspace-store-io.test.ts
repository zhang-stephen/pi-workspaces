// Unit tests for src/workspace-store.ts part 2: definition-file IO (source
// scan, atomic save), root health checks, root add/remove operations, and
// dual-source loadAll. Fixtures live in temp dirs; the global source is
// isolated by pointing PI_CODING_AGENT_DIR at an empty temp dir (getAgentDir
// reads that env var at call time).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  addRoot,
  globalWorkspacesDir,
  loadAll,
  projectWorkspacesDir,
  removeRoot,
  saveDefinition,
  scanSource,
  toWorkspaceInfo,
  type WorkspaceDefinition,
} from "../src/workspace-store.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

const DEF: WorkspaceDefinition = {
  name: "demo",
  version: 1,
  roots: [{ name: "app", path: "/ws/app" }],
  primary: "app",
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

test("scanSource of a missing directory yields empty results without warnings", () => {
  const dir = path.join(makeTempDir(), "does-not-exist");
  assert.deepEqual(scanSource(dir, "global"), { defs: [], warnings: [] });
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
      primary: "ok",
    };

    const info = toWorkspaceInfo(def, "project");

    assert.equal(info.name, "health");
    assert.equal(info.origin, "project");
    assert.equal(info.primary, "ok");
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

test("removeRoot drops a non-primary root and refuses primary/unknown names", () => {
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

  assert.throws(() => removeRoot(def, "app"), /primary/i);
  assert.throws(() => removeRoot(def, "ghost"), /unknown root/i);
});

test("loadAll merges both sources with the project source winning per name", () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.equal(globalWorkspacesDir(), path.join(agentDir, "workspaces"));
    assert.equal(projectWorkspacesDir(cwd), path.join(cwd, ".pi", "workspaces"));

    const globalDef: WorkspaceDefinition = { ...DEF, name: "shared" };
    const projectDef: WorkspaceDefinition = { ...DEF, name: "shared", primary: "docs",
      roots: [
        { name: "app", path: "/ws/app" },
        { name: "docs", path: "/ws/docs" },
      ],
    };
    const projectOnly: WorkspaceDefinition = { ...DEF, name: "project-only" };
    writeFile(agentDir, path.join("workspaces", "shared.json"), JSON.stringify(globalDef));
    writeFile(agentDir, path.join("workspaces", "global-only.json"), JSON.stringify({ ...DEF, name: "global-only" }));
    writeFile(cwd, path.join(".pi", "workspaces", "shared.json"), JSON.stringify(projectDef));
    writeFile(cwd, path.join(".pi", "workspaces", "project-only.json"), JSON.stringify(projectOnly));

    const { merged, collisions, warnings } = loadAll(cwd);

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
