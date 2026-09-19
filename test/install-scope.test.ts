// Tests for installScopeForLocation: the pure predicate behind install-scope
// detection. Global scope means the extension module lives inside one of the
// user-level install layouts pi recognizes under the agent dir (extensions/,
// npm/ for `pi install npm:...`, git/ for `pi install git:...`); everything
// else - a repo's .pi install, a pi -e checkout, a temp trial - is project
// scope, the safe default.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { installScopeForLocation } from "../index.ts";

const AGENT = path.resolve("/home/dev/.pi/agent");
const inside = (...segments: string[]): string => path.join(AGENT, ...segments);

test("user-level install layouts under the agent dir are global scope", () => {
  assert.equal(installScopeForLocation(inside("extensions", "pi-workspaces", "index.ts"), AGENT), "global");
  assert.equal(installScopeForLocation(inside("npm", "node_modules", "pi-workspaces", "index.ts"), AGENT), "global");
  assert.equal(
    installScopeForLocation(inside("git", "github.com", "zhang-stephen", "pi-workspaces", "index.ts"), AGENT),
    "global",
  );
});

test("project installs, dev checkouts and unrelated paths are project scope", () => {
  // Repo-local package install (pi install -l).
  assert.equal(installScopeForLocation(path.join("/work", "repo", ".pi", "npm", "pi-workspaces", "index.ts"), AGENT), "project");
  // pi -e checkout somewhere on disk.
  assert.equal(installScopeForLocation(path.join("/work", "pi-workspaces", "index.ts"), AGENT), "project");
  // A sibling named similarly must not count as inside.
  assert.equal(installScopeForLocation(path.join("/home/dev/.pi/agent-evil", "index.ts"), AGENT), "project");
});
