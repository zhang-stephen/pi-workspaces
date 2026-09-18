// Unit tests for src/commands.ts: the /workspace command (status, list,
// load, unload, create, add-root/add, remove-root/remove) and the pure
// format helpers. Fixtures live in temp dirs; the global definition source
// is isolated by pointing PI_CODING_AGENT_DIR at an empty temp dir
// (getAgentDir reads that env var at call time) and the project source is
// discovered by marker ascent from the cwd (fixtures create the marker).
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

test("argument completion offers subcommands, trailing space for arg-taking ones", async () => {
  const cwd = makeTempDir("pi-workspaces-cwd-");
  try {
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => null,
      setActive: () => {},
      scope: "project",
      getCwd: () => cwd,
    });
    const cmd = pi.commands.get("workspace");
    assert.ok(cmd);
    const complete = (prefix: string) =>
      (cmd as any).getArgumentCompletions(prefix) as Array<{ value: string; label: string; description?: string }> | null;

    // Bare prefix: all nine subcommands.
    assert.equal(complete("")?.length, 9);
    // Arg-taking subcommands get a trailing space so completion continues.
    assert.deepEqual(complete("lo"), [{ value: "load ", label: "load", description: "Activate a workspace by name" }]);
    assert.deepEqual(complete("unload"), [{ value: "unload", label: "unload", description: "Deactivate the active workspace" }]);
    assert.deepEqual(complete("remove-"), [
      { value: "remove-root ", label: "remove-root", description: "Remove a root from the active workspace" },
    ]);
    // Unknown subcommand text yields nothing.
    assert.equal(complete("zzz"), null);
  } finally {
    cleanup(cwd);
  }
});

test("argument completion: load offers visible workspaces minus the active one", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Global definition + project definition; the project one is active.
    writeFile(agentDir, path.join("workspaces", "glob.json"), JSON.stringify({
      name: "glob", version: 1, roots: [{ name: "g", path: cwd }],
    }));
    writeFile(cwd, path.join(".pi", "workspaces", "proj.json"), JSON.stringify({
      name: "proj", version: 1, roots: [{ name: "p", path: cwd }],
    }));

    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => ({ name: "proj", roots: [{ name: "p", path: cwd, exists: true }], origin: "project" }),
      setActive: () => {},
      scope: "global",
      getCwd: () => cwd,
    });
    const complete = (prefix: string) => (pi.commands.get("workspace") as any).getArgumentCompletions(prefix);

    // The active workspace is excluded; the global one shows its absolute
    // definition-file path as description.
    assert.deepEqual(complete("load "), [
      { value: "load glob", label: "glob", description: path.join(agentDir, "workspaces", "glob.json") },
    ]);
    // Prefix filter applies (case-insensitive).
    assert.equal(complete("load PR"), null, "the active workspace is filtered out entirely");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("argument completion: load in project scope never sees globals (D1)", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(agentDir, path.join("workspaces", "glob.json"), JSON.stringify({
      name: "glob", version: 1, roots: [{ name: "g", path: cwd }],
    }));
    writeFile(cwd, path.join(".pi", "workspaces", "proj.json"), JSON.stringify({
      name: "proj", version: 1, roots: [{ name: "p", path: cwd }],
    }));

    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => null,
      setActive: () => {},
      scope: "project",
      getCwd: () => cwd,
    });
    const complete = (prefix: string) => (pi.commands.get("workspace") as any).getArgumentCompletions(prefix);

    assert.deepEqual(complete("load "), [{ value: "load proj", label: "proj", description: "project" }]);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("argument completion: remove offers the active workspace's root names", async () => {
  const cwd = makeTempDir("pi-workspaces-cwd-");
  try {
    const pi = mockPi();
    const active = {
      name: "demo",
      origin: "project",
      roots: [
        { name: "backend", path: "/ws/backend", exists: true },
        { name: "frontend", path: "/ws/frontend", exists: true },
      ],
    } as const;
    registerWorkspaceCommands(pi, {
      getActive: () => active as unknown as WorkspaceInfo,
      setActive: () => {},
      scope: "project",
      getCwd: () => cwd,
    });
    const complete = (prefix: string) => (pi.commands.get("workspace") as any).getArgumentCompletions(prefix);

    assert.deepEqual(complete("remove "), [
      { value: "remove backend", label: "backend", description: "/ws/backend" },
      { value: "remove frontend", label: "frontend", description: "/ws/frontend" },
    ]);
    assert.deepEqual(complete("remove fr"), [
      { value: "remove frontend", label: "frontend", description: "/ws/frontend" },
    ]);
    // No active workspace: nothing to remove.
    const pi2 = mockPi();
    registerWorkspaceCommands(pi2, { getActive: () => null, setActive: () => {}, scope: "project", getCwd: () => cwd });
    assert.equal((pi2.commands.get("workspace") as any).getArgumentCompletions("remove "), null);
  } finally {
    cleanup(cwd);
  }
});

test("argument completion: add completes filesystem paths", async () => {
  const cwd = makeTempDir("pi-workspaces-cwd-");
  try {
    fs.mkdirSync(path.join(cwd, "frontend"));
    fs.mkdirSync(path.join(cwd, "backend"));
    fs.writeFileSync(path.join(cwd, "notes.txt"), "");
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => null,
      setActive: () => {},
      scope: "project",
      getCwd: () => cwd,
    });
    const complete = (prefix: string) => (pi.commands.get("workspace") as any).getArgumentCompletions(prefix);

    // Two tokens: the last one is the path; values rebuild the full argument.
    assert.deepEqual(complete("add foo fr"), [
      { value: "add foo frontend/", label: "frontend/" },
    ]);
    // A single token without separators is the free-form name.
    assert.equal(complete("add foo"), null);
    // A single token with a separator is a path.
    const rel = complete("add ./fr");
    assert.deepEqual(rel, [{ value: "add ./frontend/", label: "frontend/" }]);
    // Unknown subcommand or completed args yield nothing.
    assert.equal(complete("bogus x"), null);
    assert.equal(complete("load a b"), null);
  } finally {
    cleanup(cwd);
  }
});

test("formatStatus shows name, origin and MISSING roots (no primary)", () => {
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
    };

    const text = formatStatus(toWorkspaceInfo(def, "project"));

    assert.ok(text.includes("demo"));
    assert.ok(text.includes("origin: project"));
    assert.ok(!text.includes("primary"), "no primary mention");
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

test("formatList shows every workspace with origin and MISSING roots (no primary)", () => {
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
    };
    const globalDef: WorkspaceDefinition = {
      name: "web",
      version: 1,
      roots: [{ name: "site", path: real }],
    };

    const text = formatList([
      { def: projectDef, origin: "project" },
      { def: globalDef, origin: "global" },
    ]);

    // Project entry: origin and the MISSING marker.
    assert.ok(text.includes("demo"));
    assert.ok(text.includes("origin: project"));
    assert.ok(text.includes("MISSING"));
    // Global entry: origin, no MISSING marker on its line.
    assert.ok(text.includes("web"));
    assert.ok(text.includes("origin: global"));
    assert.ok(!text.includes("primary"), "no primary mention");
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
      { name: "demo", version: 1, roots: [{ name: "app", path: cwd }] },
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
      getCwd: () => cwd,
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

test("create persists a primary-free definition with the cwd as its sole root", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    let active: WorkspaceInfo | null = null;
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => active,
      setActive: (ws) => {
        active = ws;
      },
      scope: "project",
      getCwd: () => cwd,
    });
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);

    await handler("create demo", ctx);

    // Active immediately, one root named after the cwd basename.
    // (cast: TS flow-narrows the closure-assigned `active` to null)
    const created = active as WorkspaceInfo | null;
    assert.ok(created);
    assert.equal(created.name, "demo");
    assert.equal(created.roots.length, 1);
    assert.equal(created.roots[0].name, path.basename(cwd));
    assert.equal(created.roots[0].path, fs.realpathSync(cwd));
    assert.ok(!("primary" in created), "runtime shape carries no primary");

    // Persisted to the discovered project source, without a primary key.
    const file = path.join(cwd, ".pi", "workspaces", "demo.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.name, "demo");
    assert.deepEqual(persisted.roots, [{ name: path.basename(cwd), path: cwd }]);
    assert.ok(!("primary" in persisted), "persisted definition carries no primary");
    assert.ok(notes.every(([, level]) => level !== "error"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

// D7: an unrelated load (cwd inside none of the roots) warns but proceeds,
// gated by warnOnUnrelatedLoad.
test("load of an unrelated workspace warns (default) and activates anyway", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const elsewhere = makeTempDir("pi-workspaces-elsewhere-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: elsewhere }],
    }));

    let active: WorkspaceInfo | null = null;
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => active,
      setActive: (ws) => {
        active = ws;
      },
      scope: "project",
      getCwd: () => cwd,
    });
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);

    await handler("load demo", ctx);

    assert.equal((active as WorkspaceInfo | null)?.name, "demo", "the load proceeds despite the warning");
    const warning = notes.find(([msg, level]) => level === "warning");
    assert.ok(warning, "an unrelated load warns");
    assert.match(warning[0], /not inside any root of 'demo'/);
    assert.ok(warning[0].includes(cwd), "the warning names the session directory anchor");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd, elsewhere);
  }
});

test("load of an unrelated workspace stays silent with warnOnUnrelatedLoad: false", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const elsewhere = makeTempDir("pi-workspaces-elsewhere-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: elsewhere }],
      options: { warnOnUnrelatedLoad: false },
    }));

    let active: WorkspaceInfo | null = null;
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => active,
      setActive: (ws) => {
        active = ws;
      },
      scope: "project",
      getCwd: () => cwd,
    });
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);

    await handler("load demo", ctx);

    assert.equal((active as WorkspaceInfo | null)?.name, "demo");
    assert.ok(notes.every(([, level]) => level !== "warning"), "the option silences the warning");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd, elsewhere);
  }
});

test("load of a workspace containing the cwd does not warn", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFile(cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: cwd }],
    }));

    let active: WorkspaceInfo | null = null;
    const pi = mockPi();
    registerWorkspaceCommands(pi, {
      getActive: () => active,
      setActive: (ws) => {
        active = ws;
      },
      scope: "project",
      getCwd: () => cwd,
    });
    const { ctx, notes } = ctxCapturingNotify(cwd);
    const handler = workspaceCmd(pi);

    await handler("load demo", ctx);

    assert.equal((active as WorkspaceInfo | null)?.name, "demo");
    assert.ok(notes.every(([, level]) => level !== "warning"), "a containing load never warns");
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
      getCwd: () => cwd,
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
    // The mutation is persisted to the project source, atomically via saveDefinition.
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(persisted.roots, [
      { name: "app", path: appDir },
      { name: "docs", path: docsDir },
    ]);
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

    // Removing the last remaining root is refused (D8) and nothing persists.
    await handler("remove-root app", ctx);
    assert.ok(notes.some(([msg, level]) => /last root/i.test(msg) && level === "error"));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, [{ name: "app", path: appDir }]);
    assert.equal(setCalls, 4); // two add + two remove; the refused one did not activate
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});
