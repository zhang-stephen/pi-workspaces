// Unit tests for src/commands.ts: the /workspace command (status, list,
// load, unload, create, add-root, remove-root) and the pure format helpers.
// Fixtures live in temp dirs; the global definition source is isolated by
// pointing PI_CODING_AGENT_DIR at an empty temp dir (getAgentDir reads that
// env var at call time) and the project source is <cwd>/.pi/workspaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatList,
  formatStatus,
  registerWorkspaceCommands,
  type CommandDeps,
} from "../src/commands.ts";
import { toWorkspaceInfo, type WorkspaceDefinition } from "../src/workspace-store.ts";
import type { WorkspaceInfo } from "../src/path-resolver.ts";
import { makeTempDir, mockCtx, mockPi, writeFile } from "./helpers.ts";

type NotifyLevel = "info" | "warning" | "error";

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** mockCtx with ui.notify captured into the returned array. */
function ctxCapturingNotify(cwd: string): { ctx: ReturnType<typeof mockCtx>; notes: Array<[string, NotifyLevel | undefined]> } {
  const notes: Array<[string, NotifyLevel | undefined]> = [];
  const ctx = mockCtx(cwd);
  ctx.ui.notify = (msg: string, level?: NotifyLevel) => {
    notes.push([msg, level]);
  };
  return { ctx, notes };
}

function workspaceCmd(pi: ReturnType<typeof mockPi>): (args: string, ctx: unknown) => Promise<void> {
  const cmd = pi.commands.get("workspace");
  assert.ok(cmd, "workspace command must be registered");
  return cmd.handler as (args: string, ctx: unknown) => Promise<void>;
}

test("formatStatus shows name, origin, primary and MISSING roots", () => {
  const dir = makeTempDir();
  try {
    const real = path.join(dir, "app");
    fs.mkdirSync(real);
    const missing = path.join(dir, "gone");
    const def: WorkspaceDefinition = {
      name: "demo",
      version: 1,
      roots: [
        { name: "app", path: real },
        { name: "docs", path: missing },
      ],
      primary: "app",
    };

    const text = formatStatus(toWorkspaceInfo(def, "project"));

    assert.ok(text.includes("demo"));
    assert.ok(text.includes("origin: project"));
    assert.ok(text.includes("primary: app"));
    // Existing root listed, not flagged; missing root flagged MISSING.
    assert.ok(text.includes(fs.realpathSync(real)));
    assert.ok(text.includes(missing));
    assert.ok(text.includes("MISSING"));
    const docsLine = text.split("\n").find((line) => line.includes("docs:"));
    assert.ok(docsLine?.includes("MISSING"));
    const appLine = text.split("\n").find((line) => line.includes("app:"));
    assert.ok(appLine && !appLine.includes("MISSING"));
  } finally {
    cleanup(dir);
  }
});

test("formatList shows every workspace with origin, primary and MISSING roots", () => {
  const dir = makeTempDir();
  try {
    const real = path.join(dir, "site");
    fs.mkdirSync(real);
    const missing = path.join(dir, "gone");
    const projectDef: WorkspaceDefinition = {
      name: "demo",
      version: 1,
      roots: [
        { name: "app", path: real },
        { name: "docs", path: missing },
      ],
      primary: "app",
    };
    const globalDef: WorkspaceDefinition = {
      name: "web",
      version: 1,
      roots: [{ name: "site", path: real }],
      primary: "site",
    };

    const text = formatList([
      { def: projectDef, origin: "project" },
      { def: globalDef, origin: "global" },
    ]);

    // Project entry: origin, primary and the MISSING marker.
    assert.ok(text.includes("demo"));
    assert.ok(text.includes("origin: project"));
    assert.ok(text.includes("primary: app"));
    assert.ok(text.includes("MISSING"));
    // Global entry: origin and primary, no MISSING marker on its line.
    assert.ok(text.includes("web"));
    assert.ok(text.includes("origin: global"));
    assert.ok(text.includes("primary: site"));
    const webBlock = text.slice(text.indexOf("web"));
    assert.ok(!webBlock.includes("MISSING"));
    // Input order is preserved.
    assert.ok(text.indexOf("demo") < text.indexOf("web"));
    // An empty merged list renders a plain sentence, not an empty string.
    assert.ok(formatList([]).length > 0);
  } finally {
    cleanup(dir);
  }
});

test("unload clears the active workspace via setActive(null, ctx)", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    let activeNow: WorkspaceInfo | null = toWorkspaceInfo(
      { name: "demo", version: 1, roots: [{ name: "app", path: cwd }], primary: "app" },
      "project",
    );
    let setCalls = 0;
    let clearedWith: WorkspaceInfo | null | undefined;
    let clearedWithCtx: unknown;
    const deps: CommandDeps = {
      getActive: () => activeNow,
      setActive: (ws, ctxArg) => {
        setCalls++;
        clearedWith = ws;
        clearedWithCtx = ctxArg;
      },
      scope: "global",
    };
    const pi = mockPi();
    registerWorkspaceCommands(pi, deps);
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);

    await handler("unload", ctx);

    assert.equal(setCalls, 1);
    assert.equal(clearedWith, null);
    // Journaling is setActive's concern (pi-workspaces:active entries);
    // the command itself just delegates with the session ctx.
    assert.equal(clearedWithCtx, ctx);
    assert.ok(notes.some(([msg, level]) => /unloaded/i.test(msg) && level === "info"));

    // A second unload with nothing active errors instead of clearing again.
    activeNow = null;
    const notesBefore = notes.length;
    await handler("unload", ctx);
    assert.equal(setCalls, 1);
    assert.ok(notes.length > notesBefore);
    assert.ok(notes.some(([msg, level]) => /no workspace is active/i.test(msg) && level === "error"));

    // An unknown subcommand prints usage as an error.
    await handler("frobnicate", ctx);
    assert.ok(notes.some(([msg, level]) => msg.includes("Usage") && level === "error"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("add-root mutates the active workspace and persists the project JSON file", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Project source fixture: workspace "demo" with one root "app".
    const appDir = path.join(cwd, "app");
    fs.mkdirSync(appDir);
    const docsDir = path.join(cwd, "docs");
    fs.mkdirSync(docsDir);
    const def: WorkspaceDefinition = {
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: appDir }],
      primary: "app",
    };
    writeFile(cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify(def));

    let active: WorkspaceInfo | null = toWorkspaceInfo(def, "project");
    let setCalls = 0;
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => active,
      setActive: (ws) => {
        setCalls++;
        active = ws;
      },
      scope: "project",
    });
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);
    const file = path.join(cwd, ".pi", "workspaces", "demo.json");

    // One-arg form: the root name defaults to the basename of the path.
    await handler(`add-root ${docsDir}`, ctx);

    assert.ok(active);
    assert.deepEqual(
      active.roots.map((r) => r.name),
      ["app", "docs"],
    );
    assert.equal(active.roots.find((r) => r.name === "docs")?.path, docsDir);
    assert.equal(active.primary, "app");
    // The mutation is persisted to the project source, atomically via saveDefinition.
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(persisted.roots, [
      { name: "app", path: appDir },
      { name: "docs", path: docsDir },
    ]);
    assert.equal(persisted.primary, "app");
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), []);

    // remove-root round-trips through the same reload-mutate-persist flow.
    await handler("remove-root docs", ctx);
    assert.deepEqual(
      active.roots.map((r) => r.name),
      ["app"],
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, [{ name: "app", path: appDir }]);

    // The short aliases dispatch through the same flow.
    await handler(`add ${docsDir}`, ctx);
    assert.deepEqual(
      active.roots.map((r) => r.name),
      ["app", "docs"],
    );
    await handler("remove docs", ctx);
    assert.deepEqual(
      active.roots.map((r) => r.name),
      ["app"],
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, [{ name: "app", path: appDir }]);

    // Removing the primary root is refused and nothing is persisted.
    await handler("remove-root app", ctx);
    assert.ok(notes.some(([msg, level]) => /primary/i.test(msg) && level === "error"));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, [{ name: "app", path: appDir }]);
    assert.equal(setCalls, 4); // two add + two remove; the refused one did not activate
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});
