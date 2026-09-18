// Wiring tests for index.ts, the extension entry: the factory registers
// the seven tool overrides and the /workspace command plus both event
// handlers; session_start activates by containment (auto-load for a single
// containing workspace with activation "auto", a select prompt otherwise,
// never outside every root) and stays silent about scan diagnostics (D1 of
// the 2026-09-19 spec) while collision notices follow the relevance matrix
// (D2); setActive is
// the single journal point (pi-workspaces:active entries, deduped per
// 16.5); before_agent_start appends the workspace section only while a
// workspace is active; the @root autocomplete provider registers only on
// UI sessions. Fixtures live in temp dirs; the global source is isolated
// via PI_CODING_AGENT_DIR.
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

/** Pin the project source to the cwd itself without any definitions. */
function markProjectRoot(cwd: string): void {
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
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
    markProjectRoot(fx.cwd);
    const pi = mockPi();
    factory(pi, "global");

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

test("session_start auto-loads the single containing workspace and journals it", async () => {
  const fx = isolatedFixture();
  try {
    // "demo" contains the session cwd (root = cwd) and resolves activation
    // "auto" (builtin default) -> auto-load. "other" contains nothing near
    // the cwd and must stay inactive.
    const def = {
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));
    const otherDir = path.join(fx.agentDir, "other-root");
    fs.mkdirSync(otherDir);
    const otherDef = {
      name: "other",
      version: 1,
      roots: [{ name: "o", path: otherDir }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "other.json"), JSON.stringify(otherDef));
    // A corrupt file and a project definition colliding on "other" are both
    // present; both must stay silent at startup (D1/D2).
    writeFile(fx.agentDir, path.join("workspaces", "broken.json"), "{ not json");
    writeFile(fx.cwd, path.join(".pi", "workspaces", "other.json"), JSON.stringify(otherDef));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, statuses, notes } = ctxCapturingUi(fx.cwd);

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // setActive is the single journal point: exactly one entry, naming "demo".
    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.equal(pi.entries.size, 1);
    // Statusline renders the active workspace under the fixed key.
    assert.ok(
      statuses.some(
        ([key, text]) => key === "pi-workspaces" && typeof text === "string" && text.includes("demo") && text.includes("(1 roots)"),
      ),
    );
    // The auto-load is announced.
    assert.ok(notes.some(([msg]) => msg.includes("'demo'") && /auto-loaded/i.test(msg)));
    // Startup silence (2026-09-19 spec D1): the corrupt file and the
    // "other" collision are unrelated to this session - no warning- or
    // error-level notification at all. "demo" itself has no collision,
    // so no collision info line either (D2).
    assert.equal(notes.filter(([, level]) => level === "warning" || level === "error").length, 0);
    assert.ok(!notes.some(([msg]) => msg.includes("also defined")));
  } finally {
    fx.restore();
  }
});

test("session_start: activating a collided workspace appends the project-wins info line (Case A)", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // Both sources define "demo"; the project copy wins the merge and the
    // cwd sits inside the project root, so the auto-load fires and the
    // info line accompanies the activation notice.
    const globalDir = makeTempDir("pi-workspaces-global-");
    writeFile(fx.cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    }));
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "old", path: globalDir }],
    }));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, notes } = ctxCapturingUi(fx.cwd);
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.ok(notes.some(([msg]) => /auto-loaded/i.test(msg)));
    assert.ok(
      notes.some(([msg, level]) => level === "info" && msg.includes("'demo'") && /project definition wins/.test(msg)),
      "the Case A info line accompanies the activation",
    );
    assert.equal(notes.filter(([, level]) => level === "warning" || level === "error").length, 0);
    cleanup(globalDir);
  } finally {
    fx.restore();
  }
});

test("session_start: cwd matching only the overridden global definition warns and stays inactive (Case B)", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // The shadowed global copy contains the cwd; the winning project copy
    // does not. The merged workspace contains nothing, so the shadowed
    // root is the only claim on the directory: warn, never activate.
    writeFile(fx.cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "new", path: path.join(fx.agentDir, "new-root") }],
    }));
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "old", path: fx.cwd }],
    }));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, statuses, notes } = ctxCapturingUi(fx.cwd);
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.equal(pi.entries.size, 0, "nothing is activated, so nothing is journaled");
    assert.ok(
      statuses.some(([key, text]) => key === "pi-workspaces" && text === undefined),
      "the statusline stays cleared",
    );
    assert.ok(
      notes.some(
        ([msg, level]) =>
          level === "warning" &&
          msg.includes("global definition of 'demo'") &&
          /overrides it \(different roots\)/.test(msg),
      ),
      "the Case B warning names the overridden workspace",
    );
    assert.ok(!notes.some(([msg]) => /auto-loaded|restored|'demo' loaded/i.test(msg)));
  } finally {
    fx.restore();
  }
});

test("session_start: cwd inside both sides of a collision activates with the info line (Case C)", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // The same directory is a root of both copies; the project copy wins,
    // auto-loads, and Case C degrades to Case A (info line, no warning).
    writeFile(fx.cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    }));
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "old", path: fx.cwd }],
    }));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, notes } = ctxCapturingUi(fx.cwd);
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.ok(notes.some(([msg]) => /auto-loaded/i.test(msg)));
    assert.ok(notes.some(([msg, level]) => level === "info" && /project definition wins/.test(msg)));
    assert.equal(notes.filter(([, level]) => level === "warning" || level === "error").length, 0);
  } finally {
    fx.restore();
  }
});

test("session_start: journal restore of a collided workspace appends the info line", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // The cwd sits outside every root, so the journaled workspace comes
    // back via the restore path; the collision info line follows it.
    const elsewhere = makeTempDir("pi-workspaces-elsewhere-");
    writeFile(fx.cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: elsewhere }],
    }));
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "old", path: path.join(fx.agentDir, "old-root") }],
    }));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, notes } = ctxCapturingUi(fx.cwd);
    ctx.sessionManager.getEntries = () => [
      { type: "custom", customType: "pi-workspaces:active", data: { name: "demo" } },
    ] as unknown as ReturnType<typeof ctx.sessionManager.getEntries>;
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(pi.entries.get("pi-workspaces:active"), undefined, "restore re-activation is journal-deduped");
    assert.ok(notes.some(([msg]) => /restored from this session's journal/i.test(msg)));
    assert.ok(notes.some(([msg, level]) => level === "info" && /project definition wins/.test(msg)));
    cleanup(elsewhere);
  } finally {
    fx.restore();
  }
});

test("session_start: selecting a collided workspace in the prompt appends the info line", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // activation "prompt" via the project config file (D4) + collision:
    // the user's selection activates with the Case A info line.
    writeFile(fx.cwd, path.join(".pi", "pi-workspaces.json"), JSON.stringify({ activation: "prompt" }));
    writeFile(fx.cwd, path.join(".pi", "workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    }));
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify({
      name: "demo",
      version: 1,
      roots: [{ name: "old", path: path.join(fx.agentDir, "old-root") }],
    }));

    const pi = mockPi();
    factory(pi, "global");
    const statuses: Array<[string, string | undefined]> = [];
    const notes: Array<[string, "info" | "warning" | "error" | undefined]> = [];
    const ctx = mockCtx(fx.cwd, { hasUI: true });
    ctx.ui.setStatus = (key: string, text: string | undefined) => {
      statuses.push([key, text]);
    };
    ctx.ui.notify = (msg: string, level?: "info" | "warning" | "error") => {
      notes.push([msg, level]);
    };
    ctx.ui.select = async () => "demo";

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.ok(notes.some(([msg]) => msg.includes("'demo' loaded")));
    assert.ok(notes.some(([msg, level]) => level === "info" && /project definition wins/.test(msg)));
    assert.equal(notes.filter(([, level]) => level === "warning" || level === "error").length, 0);
  } finally {
    fx.restore();
  }
});

test("session_start auto-loads from any containing root, not just the first", async () => {
  const fx = isolatedFixture();
  try {
    // The cwd sits two levels beneath the SECOND root of "demo" - no
    // primary concept gates the auto-load anymore.
    const rootA = makeTempDir("pi-workspaces-roota-");
    const rootB = makeTempDir("pi-workspaces-rootb-");
    const cwd = path.join(rootB, "src", "deep");
    fs.mkdirSync(cwd, { recursive: true });
    markProjectRoot(cwd);
    const def = {
      name: "demo",
      version: 1,
      roots: [
        { name: "a", path: rootA },
        { name: "b", path: rootB },
      ],
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx, notes } = ctxCapturingUi(cwd);
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "demo" }]);
    assert.ok(notes.some(([msg]) => /auto-loaded/i.test(msg)));
    cleanup(rootA, rootB);
  } finally {
    fx.restore();
  }
});

// 16.5: re-activation of the already-journaled workspace (e.g. after a
// reload) must not duplicate the pi-workspaces:active journal entry.
test("setActive skips the journal write when the last entry already names the workspace", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    const def = {
      name: "demo",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));

    const pi = mockPi();
    factory(pi, "global");
    const { ctx } = ctxCapturingUi(fx.cwd);
    // The session journal already records "demo" as active (resume after
    // a reload): the auto-load re-activation must not append a duplicate.
    ctx.sessionManager.getEntries = () => [
      { type: "custom", customType: "pi-workspaces:active", data: { name: "demo" } },
    ] as unknown as ReturnType<typeof ctx.sessionManager.getEntries>;

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.equal(pi.entries.get("pi-workspaces:active"), undefined, "no duplicate journal entry");
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
    };
    writeFile(fx.agentDir, path.join("workspaces", "demo.json"), JSON.stringify(def));

    const pi = mockPi();
    factory(pi, "global");
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

    // session_start auto-loads "demo" (the cwd sits inside its root).
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

test("session_start prompts for a single containing workspace with activation 'prompt'", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // activation "prompt" comes from the project config file now (D4) -
    // definitions carry no options of their own.
    writeFile(fx.cwd, path.join(".pi", "pi-workspaces.json"), JSON.stringify({ activation: "prompt" }));
    const holderDef = {
      name: "holder",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    };
    const otherDef = {
      name: "other",
      version: 1,
      roots: [{ name: "o", path: path.join(fx.agentDir, "other-root") }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "holder.json"), JSON.stringify(holderDef));
    writeFile(fx.agentDir, path.join("workspaces", "other.json"), JSON.stringify(otherDef));

    const pi = mockPi();
    factory(pi, "global");
    const selects: Array<{ message: string; items: string[] }> = [];
    const ctx = mockCtx(fx.cwd, { hasUI: true });
    ctx.ui.select = async (message: string, items: string[]) => {
      selects.push({ message, items });
      return undefined;
    };

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // Only the containing workspace is offered, with the escape hatch.
    assert.deepEqual(selects, [
      { message: "Load a workspace for this session?", items: ["holder", "Don't load"] },
    ]);
    // Declining the prompt activates nothing.
    assert.equal(pi.entries.get("pi-workspaces:active"), undefined);
  } finally {
    fx.restore();
  }
});

test("session_start prompts over ALL containing workspaces on a multi-match, even all-auto", async () => {
  const fx = isolatedFixture();
  try {
    markProjectRoot(fx.cwd);
    // Both workspaces contain the cwd and both resolve activation "auto";
    // disambiguation always prompts.
    for (const name of ["alpha", "beta"]) {
      writeFile(
        fx.agentDir,
        path.join("workspaces", `${name}.json`),
        JSON.stringify({ name, version: 1, roots: [{ name: "r", path: fx.cwd }] }),
      );
    }

    const pi = mockPi();
    factory(pi, "global");
    const selects: Array<{ message: string; items: string[] }> = [];
    const ctx = mockCtx(fx.cwd, { hasUI: true });
    ctx.ui.select = async (message: string, items: string[]) => {
      selects.push({ message, items });
      return "beta";
    };

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.deepEqual(selects, [
      { message: "Load a workspace for this session?", items: ["alpha", "beta", "Don't load"] },
    ]);
    // Choosing from the prompt activates the choice and journals it.
    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "beta" }]);
  } finally {
    fx.restore();
  }
});

test("session_start never prompts when the cwd is outside every workspace root", async () => {
  const fx = isolatedFixture();
  const alphaDir = makeTempDir("pi-workspaces-alpha-");
  const betaDir = makeTempDir("pi-workspaces-beta-");
  try {
    markProjectRoot(fx.cwd);
    const alphaDef = {
      name: "alpha",
      version: 1,
      roots: [{ name: "a", path: alphaDir }],
    };
    const betaDef = {
      name: "beta",
      version: 1,
      roots: [{ name: "b", path: betaDir }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "alpha.json"), JSON.stringify(alphaDef));
    writeFile(fx.agentDir, path.join("workspaces", "beta.json"), JSON.stringify(betaDef));

    const pi = mockPi();
    factory(pi, "global");
    const selects: Array<{ message: string; items: string[] }> = [];
    const ctx = mockCtx(fx.cwd, { hasUI: true });
    ctx.ui.select = async (message: string, items: string[]) => {
      selects.push({ message, items });
      return undefined;
    };

    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // Definitions exist, yet no workspace contains the cwd - the prompt
    // must not fire (D2). Loading from an unrelated directory is always an
    // explicit /workspace load.
    assert.deepEqual(selects, []);
    assert.equal(pi.entries.get("pi-workspaces:active"), undefined);
  } finally {
    cleanup(alphaDir, betaDir);
    fx.restore();
  }
});

test("project scope sees only the project source and ignores the global config", async () => {
  const fx = isolatedFixture();
  const rootDir = makeTempDir("pi-workspaces-root-");
  try {
    // A global definition that must stay invisible in project scope, and a
    // global config file that must not be read either.
    const ghostDef = {
      name: "ghost",
      version: 1,
      roots: [{ name: "g", path: rootDir }],
    };
    writeFile(fx.agentDir, path.join("workspaces", "ghost.json"), JSON.stringify(ghostDef));
    writeFile(fx.agentDir, "pi-workspaces.json", JSON.stringify({ activation: "prompt" }));
    // The project definition lives under <cwd>/.pi/workspaces and contains
    // the cwd, so auto-load fires - unless the (unreadable) global config
    // file were consulted, which would switch activation to "prompt".
    const projDef = {
      name: "proj",
      version: 1,
      roots: [{ name: "app", path: fx.cwd }],
    };
    writeFile(fx.cwd, path.join(".pi", "workspaces", "proj.json"), JSON.stringify(projDef));

    const pi = mockPi();
    factory(pi, "project");
    const { ctx, notes } = ctxCapturingUi(fx.cwd);
    await emit(pi.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // The project definition auto-loaded (built-in defaults apply, not the
    // unreadable global config file), and the global 'ghost' never surfaced -
    // no collision or visibility of any kind.
    assert.deepEqual(pi.entries.get("pi-workspaces:active"), [{ name: "proj" }]);
    assert.ok(
      notes.some(([msg]) => msg.includes("auto-loaded")),
      "expected the auto-load notification",
    );
    assert.ok(
      !notes.some(([msg]) => msg.includes("ghost")),
      "the global definition must not leak into project scope",
    );
  } finally {
    cleanup(rootDir);
    fx.restore();
  }
});
