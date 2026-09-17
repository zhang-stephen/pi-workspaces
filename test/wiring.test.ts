// Wiring tests for index.ts, the extension entry: the factory registers
// the seven tool overrides and the /workspace command plus both event
// handlers; session_start auto-loads the workspace whose primary root is
// the session cwd (and notifies warnings/collisions); setActive is the
// single journal point (pi-workspaces:active entries); before_agent_start
// appends the workspace section only while a workspace is active; the
// @root autocomplete provider registers only on UI sessions. Fixtures live
// in temp dirs; the global source is isolated via PI_CODING_AGENT_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import factory from "../index.ts";
import { emit, makeTempDir, mockCtx, mockPi, writeFile } from "./helpers.ts";

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** Isolated fixture: fresh agent dir (global source) + session cwd. */
function isolatedFixture(): { agentDir: string; cwd: string; restore: () => void } {
  const agentDir = makeTempDir("pi-workspaces-agent-");
  const cwd = makeTempDir("pi-workspaces-cwd-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    agentDir,
    cwd,
    restore() {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      cleanup(agentDir, cwd);
    },
  };
}

/** mockCtx with ui.setStatus/ui.notify captured into arrays. */
function ctxCapturingUi(cwd: string): {
  ctx: ReturnType<typeof mockCtx>;
  statuses: Array<[string, string | undefined]>;
  notes: Array<[string, "info" | "warning" | "error" | undefined]>;
} {
  const statuses: Array<[string, string | undefined]> = [];
  const notes: Array<[string, "info" | "warning" | "error" | undefined]> = [];
  const ctx = mockCtx(cwd);
  ctx.ui.setStatus = (key: string, text: string | undefined) => {
    statuses.push([key, text]);
  };
  ctx.ui.notify = (msg: string, level?: "info" | "warning" | "error") => {
    notes.push([msg, level]);
  };
  return { ctx, statuses, notes };
}

const TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls", "bash"];

test("factory registers the 7 tool overrides, the /workspace command and both event handlers", async () => {
  const fx = isolatedFixture();
  try {
    const pi = mockPi();
    factory(pi);

    for (const name of TOOL_NAMES) {
      assert.ok(pi.tools.has(name), `tool '${name}' must be registered`);
    }
    assert.ok(pi.commands.has("workspace"), "the /workspace command must be registered");
    assert.ok((pi.handlers.get("session_start") ?? []).length > 0, "session_start handler must be registered");
    assert.ok((pi.handlers.get("before_agent_start") ?? []).length > 0, "before_agent_start handler must be registered");

    // The @root autocomplete provider is registered on session_start only
    // when the session has a UI; headless sessions get no provider.
    let uiProvider: unknown;
    const uiCtx = mockCtx(fx.cwd, { hasUI: true });
    uiCtx.ui.addAutocompleteProvider = (factoryArg: unknown) => {
      uiProvider = factoryArg;
    };
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, uiCtx);
    assert.equal(typeof uiProvider, "function", "a UI session must register the autocomplete provider factory");

    let headlessRegistered = false;
    const headlessCtx = mockCtx(fx.cwd);
    headlessCtx.ui.addAutocompleteProvider = () => {
      headlessRegistered = true;
    };
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, headlessCtx);
    assert.equal(headlessRegistered, false, "a headless session must not register an autocomplete provider");
  } finally {
    fx.restore();
  }
});

test("session_start auto-loads the workspace whose primary root is the session cwd and journals it", async () => {
  const fx = isolatedFixture();
  try {
    // "demo"'s primary root IS the session cwd -> auto-load (builtin
    // autoLoadInPrimary default). "other" must stay inactive.
    const def = {
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
      primary: "app",
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));
    const otherDir = path.join(fx.agentDir, "other-root");
    fs.mkdirSync(otherDir);
    const otherDef = {
      name: "other",
      version: 1,
      roots: [{ name: "o", path: otherDir }],
      primary: "o",
    };
    writeFile(fx.agentDir, path.join("workspaces", "other.json"), JSON.stringify(otherDef));
    // A corrupt file warns; a project definition colliding on "other" warns too.
    writeFile(fx.agentDir, path.join("workspaces", "broken.json"), "{ not json");
    writeFile(fx.cwd, path.join(".pi", "workspaces", "other.json"), JSON.stringify(otherDef));

    const pi = mockPi();
    factory(pi);
    const { ctx, statuses, notes } = ctxCapturingUi(fx.cwd);

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // setActive is the single journal point: exactly one entry, naming "demo".
    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.equal(pi.entries.size, 1);
    // Statusline renders the active workspace under the fixed key.
    assert.ok(
      statuses.some(
        ([key, text]) => key === "pi-workspaces" && typeof text === "string" && text.includes("demo") && text.includes("primary: app"),
      ),
    );
    // The auto-load is announced.
    assert.ok(notes.some(([msg]) => msg.includes("'demo'") && /auto-loaded/i.test(msg)));
    // Warnings and collisions are notified at warning level.
    assert.ok(notes.some(([msg, level]) => level === "warning" && msg.includes("broken.json")));
    assert.ok(notes.some(([msg, level]) => level === "warning" && msg.includes("'other'") && /both/i.test(msg)));
  } finally {
    fx.restore();
  }
});

test("before_agent_start appends the workspace section only when a workspace is active", async () => {
  const fx = isolatedFixture();
  try {
    const def = {
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
      primary: "app",
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));

    const pi = mockPi();
    factory(pi);
    const { ctx } = ctxCapturingUi(fx.cwd);
    // The handler only reads type/systemPrompt; node:test strips types, so
    // the literal is pinned against the real event shape with a cast.
    const beforeEvent = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "BASE PROMPT",
      systemPromptOptions: {},
    } as any; // node:test strips types; emit pins against the real event shape

    // Inactive: the handler returns undefined and leaves the prompt alone.
    let results = await emit(pi.handlers, "before_agent_start", beforeEvent, ctx);
    assert.equal(results.length, 1);
    assert.equal(results[0], undefined);

    // session_start auto-loads "demo" (the cwd is its primary root).
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    results = await emit(pi.handlers, "before_agent_start", beforeEvent, ctx);
    const appended = results[0] as { systemPrompt?: string } | undefined;
    assert.ok(appended && typeof appended.systemPrompt === "string");
    assert.ok(appended.systemPrompt.startsWith("BASE PROMPT"));
    assert.ok(appended.systemPrompt.includes("## Workspace 'demo'"));
    assert.ok(appended.systemPrompt.includes("@app ->"));

    // /workspace unload deactivates through the same setActive point: the
    // unload is journaled as { name: null } and the prompt stays untouched.
    const handler = pi.commands.get("workspace")?.handler;
    assert.ok(handler);
    await handler("unload", ctx);
    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }, { name: null }]);

    results = await emit(pi.handlers, "before_agent_start", beforeEvent, ctx);
    assert.equal(results[0], undefined);
  } finally {
    fx.restore();
  }
});

test("session_start select offers only the containing workspace when the cwd is inside a non-primary root", async () => {
  const fx = isolatedFixture();
  const primaryDir = makeTempDir("pi-workspaces-primary-");
  const libDir = makeTempDir("pi-workspaces-lib-");
  const otherDir = makeTempDir("pi-workspaces-other-");
  try {
    // "holder" declares "lib" as a non-primary root; the session cwd sits
    // inside it. "other" contains nothing near the cwd.
    const holderDef = {
      name: "holder",
      version: 1,
      roots: [
        { name: "app", path: primaryDir },
        { name: "lib", path: libDir },
      ],
      primary: "app",
    };
    const otherDef = {
      name: "other",
      version: 1,
      roots: [{ name: "o", path: otherDir }],
      primary: "o",
    };
    writeFile(fx.agentDir, path.join("workspaces", "holder.json"), JSON.stringify(holderDef));
    writeFile(fx.agentDir, path.join("workspaces", "other.json"), JSON.stringify(otherDef));

    // The cwd is no workspace's primary root, so no auto-load pre-empts the
    // prompt; it sits beneath "holder"'s non-primary "lib" root.
    const cwd = path.join(libDir, "deep");
    fs.mkdirSync(cwd);

    const pi = mockPi();
    factory(pi);
    const selects: Array<{ message: string; items: string[] }> = [];
    const ctx = mockCtx(cwd, { hasUI: true });
    ctx.ui.select = async (message: string, items: string[]) => {
      selects.push({ message, items });
      return undefined;
    };

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // Two-layer semantics: only the containing workspace is offered, with
    // the escape hatch appended.
    assert.deepEqual(selects, [
      { message: "Load a workspace for this session?", items: ["holder", "Don't load"] },
    ]);
    // Declining the prompt activates nothing.
    assert.equal(pi.entries.get("pi-workspaces:active"), undefined);
  } finally {
    cleanup(primaryDir, libDir, otherDir);
    fx.restore();
  }
});

test("session_start select offers every promptable workspace when the cwd is outside all roots", async () => {
  const fx = isolatedFixture();
  const alphaDir = makeTempDir("pi-workspaces-alpha-");
  const betaDir = makeTempDir("pi-workspaces-beta-");
  try {
    const alphaDef = {
      name: "alpha",
      version: 1,
      roots: [{ name: "a", path: alphaDir }],
      primary: "a",
    };
    const betaDef = {
      name: "beta",
      version: 1,
      roots: [{ name: "b", path: betaDir }],
      primary: "b",
    };
    writeFile(fx.agentDir, path.join("workspaces", "alpha.json"), JSON.stringify(alphaDef));
    writeFile(fx.agentDir, path.join("workspaces", "beta.json"), JSON.stringify(betaDef));

    const pi = mockPi();
    factory(pi);
    const selects: Array<{ message: string; items: string[] }> = [];
    const ctx = mockCtx(fx.cwd, { hasUI: true });
    ctx.ui.select = async (message: string, items: string[]) => {
      selects.push({ message, items });
      return undefined;
    };

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // No workspace contains the cwd, so the prompt falls back to every
    // promptable workspace (sorted source order) plus the escape hatch.
    assert.deepEqual(selects, [
      { message: "Load a workspace for this session?", items: ["alpha", "beta", "Don't load"] },
    ]);
    assert.equal(pi.entries.get("pi-workspaces:active"), undefined);
  } finally {
    cleanup(alphaDir, betaDir);
    fx.restore();
  }
});
