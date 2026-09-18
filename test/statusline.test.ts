// Unit tests for src/statusline.ts: the footer status renderer and the
// setStatus refresh helper. renderStatus is pure (colors injected via fg);
// refreshStatus only touches ctx.ui.setStatus / ctx.ui.theme.fg.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceInfo } from "../src/path-resolver.ts";
import { renderStatus, refreshStatus } from "../src/statusline.ts";

/** Recording fg: wraps text as <color:text> and remembers every call. */
function makeFg(): { fg: (color: string, text: string) => string; calls: { color: string; text: string }[] } {
  const calls: { color: string; text: string }[] = [];
  const fg = (color: string, text: string): string => {
    calls.push({ color, text });
    return `<${color}:${text}>`;
  };
  return { fg, calls };
}

function ws(roots: [string, boolean][], name = "demo"): WorkspaceInfo {
  return {
    name,
    roots: roots.map(([rname, exists]) => ({ name: rname, path: `/ws/${rname}`, exists })),
    origin: "project",
  };
}

test("statusline: healthy format is '[ws] <name> (N roots)'", () => {
  const healthy = ws([
    ["alpha", true],
    ["beta", true],
    ["gamma", true],
  ]);
  const { fg, calls } = makeFg();

  const text = renderStatus(healthy, fg);

  assert.equal(text, "<accent:[ws]> <accent:demo> <dim:(3 roots)>");
  assert.deepEqual(
    calls.map((c) => c.color),
    ["accent", "accent", "dim"],
    "icon and name use accent, counts use dim",
  );
  assert.ok(!/[^\x00-\x7F]/.test(text), "status text must be pure ASCII");
});

test("statusline: degraded format shows ok/N counts and one warning per missing root", () => {
  const degraded = ws([
    ["alpha", true],
    ["beta", false],
    ["gamma", false],
  ]);
  const { fg, calls } = makeFg();

  const text = renderStatus(degraded, fg);

  assert.equal(
    text,
    "<accent:[ws]> <accent:demo> <dim:(1/3 roots)>" +
      "<warning: ! beta missing><warning: ! gamma missing>",
  );
  const warningCalls = calls.filter((c) => c.color === "warning");
  assert.deepEqual(
    warningCalls.map((c) => c.text),
    [" ! beta missing", " ! gamma missing"],
    "one warning-colored ' ! <name> missing' marker per missing root, in root order",
  );
  assert.ok(!/[^\x00-\x7F]/.test(text), "status text must be pure ASCII");
});

test("refreshStatus: sets keyed status when active, clears with undefined when inactive", () => {
  const calls: { key: string; text: string | undefined }[] = [];
  const ctx = {
    ui: {
      theme: { fg: (_color: unknown, text: string): string => text },
      setStatus: (key: string, text: string | undefined): void => {
        calls.push({ key, text });
      },
    },
  };

  refreshStatus(ctx, ws([
    ["alpha", true],
    ["beta", true],
  ]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "pi-workspaces");
  assert.equal(calls[0].text, "[ws] demo (2 roots)");

  refreshStatus(ctx, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].key, "pi-workspaces");
  assert.equal(calls[1].text, undefined, "inactive workspace clears the status");
});

test("refreshStatus: survives pi's Theme class whose fg method relies on `this`", () => {
  // Regression: ctx.ui.theme.fg is a class method on pi's Theme. Passing the
  // bare reference detaches `this` and crashes on this.fgColors. refreshStatus
  // must wrap it in a closure.
  class FakeTheme {
    private fgColors = new Map([["accent", "A"], ["dim", "D"], ["warning", "W"]]);
    fg(color: string, text: string): string {
      const c = this.fgColors.get(color);
      if (!c) throw new Error(`Unknown theme color: ${color}`);
      return `<${c}:${text}>`;
    }
  }
  const calls: { key: string; text: string | undefined }[] = [];
  const ctx = {
    ui: {
      theme: new FakeTheme(),
      setStatus: (key: string, text: string | undefined): void => {
        calls.push({ key, text });
      },
    },
  };
  refreshStatus(ctx, ws([["alpha", true]]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "<A:[ws]> <A:demo> <D:(1 roots)>");
});

test("refreshStatus: headless fallbacks - no theme, no ui, no setStatus", () => {
  const calls: { key: string; text: string | undefined }[] = [];
  const setStatus = (key: string, text: string | undefined): void => {
    calls.push({ key, text });
  };

  // print/RPC-style context: setStatus is a no-op stub and theme is undefined.
  const headless = { ui: { theme: undefined, setStatus } };
  refreshStatus(headless, ws([["alpha", true]]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "[ws] demo (1 roots)", "colors fall back to passthrough");

  // No ui at all, or ui without setStatus: must not throw.
  refreshStatus({}, ws([["alpha", true]]));
  refreshStatus({ ui: {} }, ws([["alpha", true]]));
  refreshStatus({}, null);
  assert.equal(calls.length, 1, "no further setStatus calls when ui is unusable");
});
