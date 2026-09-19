// Tests for the /workspace config subcommand: bare show with provenance,
// set/unset per level (default level global in global scope), validation,
// scope isolation (D1), the global-only ascend key (D4), and argument
// completion. Fixtures live in temp dirs; the global source is isolated by
// pointing PI_CODING_AGENT_DIR at an empty temp dir (getAgentDir reads that
// env var at call time).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerWorkspaceCommands } from "../src/commands.ts";
import { makeTempDir, mockCtx, mockPi, writeFile } from "./helpers.ts";

type NotifyLevel = "info" | "warning" | "error";

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

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

function register(scope: "global" | "project", cwd: string): (args: string, ctx: unknown) => Promise<void> {
  const pi = mockPi();
  registerWorkspaceCommands(pi, { getActive: () => null, setActive: () => {}, scope, getCwd: () => cwd });
  return workspaceCmd(pi);
}

test("config set defaults to the global file in global scope; level token opts into project", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handler = register("global", cwd);
    const { ctx, notes } = ctxCapturingNotify(cwd);

    // No level token: global file (the personal defaults).
    await handler("config set activation prompt", ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "pi-workspaces.json"), "utf8")), {
      activation: "prompt",
    });
    assert.ok(notes.at(-1)![0].includes("new sessions"), "the effect-timing note is reported");

    // Explicit project token: project file.
    await handler("config set warnOnUnrelatedLoad false project", ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "pi-workspaces.json"), "utf8")), {
      warnOnUnrelatedLoad: false,
    });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("config set in project scope defaults to project and rejects the global level (D1)", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handler = register("project", cwd);
    const { ctx, notes } = ctxCapturingNotify(cwd);

    await handler("config set activation prompt", ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "pi-workspaces.json"), "utf8")), {
      activation: "prompt",
    });

    notes.length = 0;
    await handler("config set activation auto global", ctx);
    assert.ok(notes.some(([msg, level]) => /never read or write the global config/i.test(msg) && level === "error"));
    assert.ok(!fs.existsSync(path.join(agentDir, "pi-workspaces.json")), "the global file is never created");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("config set validates keys, values and arity", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handler = register("global", cwd);
    const { ctx, notes } = ctxCapturingNotify(cwd);

    await handler("config set bogus true", ctx);
    assert.ok(notes.at(-1)![0].includes("Unknown config key 'bogus'"));

    await handler("config set activation sometimes", ctx);
    assert.ok(/Invalid value for 'activation'/.test(notes.at(-1)![0]));

    await handler("config set projectRootAscend many", ctx);
    assert.ok(/Invalid value for 'projectRootAscend'/.test(notes.at(-1)![0]));

    await handler("config set activation", ctx);
    assert.ok(notes.at(-1)![0].startsWith("Usage:"));

    assert.equal(
      fs.readdirSync(agentDir).filter((n) => n === "pi-workspaces.json").length,
      0,
      "rejected writes never create the global file",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("projectRootAscend is global-only: project-level writes are refused (D4)", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handler = register("global", cwd);
    const { ctx, notes } = ctxCapturingNotify(cwd);

    await handler("config set projectRootAscend 5 project", ctx);
    assert.ok(notes.some(([msg, level]) => /global-only key/i.test(msg) && level === "error"));

    await handler("config set projectRootAscend 5", ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "pi-workspaces.json"), "utf8")), {
      projectRootAscend: 5,
    });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("config unset removes the key and reports the fallback value", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fs.writeFileSync(path.join(agentDir, "pi-workspaces.json"), JSON.stringify({ activation: "prompt" }));
    const handler = register("global", cwd);
    const { ctx, notes } = ctxCapturingNotify(cwd);

    await handler("config unset activation", ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "pi-workspaces.json"), "utf8")), {});
    assert.ok(/Effective value is now "auto"/.test(notes.at(-1)![0]), "falls back to the builtin default");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("bare config shows effective values with provenance; project scope hides globals", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fs.writeFileSync(path.join(agentDir, "pi-workspaces.json"), JSON.stringify({ activation: "prompt" }));
    writeFile(cwd, path.join(".pi", "pi-workspaces.json"), JSON.stringify({ warnOnUnrelatedLoad: false }));

    const show = async (scope: "global" | "project"): Promise<string> => {
      const handler = register(scope, cwd);
      const { ctx, notes } = ctxCapturingNotify(cwd);
      await handler("config", ctx);
      return notes.at(-1)![0];
    };

    const globalView = await show("global");
    assert.ok(/activation\s+prompt\s+global \(/.test(globalView), "activation comes from the global file");
    assert.ok(
      /warnOnUnrelatedLoad\s+false\s+project \(/.test(globalView),
      "warnOnUnrelatedLoad comes from the project file",
    );
    assert.ok(/projectRootAscend\s+3\s+builtin default/.test(globalView), "unset keys show the builtin default");

    const projectView = await show("project");
    assert.ok(/warnOnUnrelatedLoad\s+false\s+project \(/.test(projectView));
    assert.ok(!projectView.includes("global ("), "the global level is invisible in project scope");
    assert.ok(/projectRootAscend\s+3\s+builtin default \(global-only key\)/.test(projectView));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});

test("config argument completion: ops, keys, values, scope-aware levels", async () => {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = mockPi();
    registerWorkspaceCommands(pi, { getActive: () => null, setActive: () => {}, scope: "global", getCwd: () => cwd });
    const complete = (prefix: string) =>
      (pi.commands.get("workspace") as any).getArgumentCompletions(prefix) as Array<{ value: string; label: string }> | null;

    assert.deepEqual(complete("config "), [
      { value: "config set ", label: "set", description: "Set a config key (default level: global)" },
      { value: "config unset ", label: "unset", description: "Remove a config key override" },
    ]);
    assert.deepEqual(complete("config se"), [
      { value: "config set ", label: "set", description: "Set a config key (default level: global)" },
    ]);

    const keys = complete("config set ");
    assert.ok(keys!.some((item) => item.value === "config set activation "));
    assert.ok(keys!.some((item) => item.value === "config set projectRootAscend "));

    assert.deepEqual(complete("config set activation "), [
      { value: "config set activation auto", label: "auto" },
      { value: "config set activation prompt", label: "prompt" },
    ]);
    // Free-form integer keys suggest nothing.
    assert.equal(complete("config set projectRootAscend "), null);

    // Levels: both for ordinary keys in global scope...
    assert.deepEqual(complete("config set activation auto ")?.map((item) => item.label), ["global", "project"]);
    // ...only global for the global-only ascend key.
    assert.deepEqual(complete("config set projectRootAscend 5 ")?.map((item) => item.label), ["global"]);
    assert.deepEqual(complete("config unset activation ")?.map((item) => item.label), ["global", "project"]);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    cleanup(agentDir, cwd);
  }
});
