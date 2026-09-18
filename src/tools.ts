// Tool overrides for the file tools read/write/edit and the search tools
// grep/find/ls, plus the bash tool with an added cwd parameter
// (FILE_TOOL_SPECS covers the six file tools; bash is registered separately
// because its schema has no path parameter to resolve - it grows an
// optional cwd instead).
// Each override is a thin wrapper around the built-in definition produced by
// pi's createXxxToolDefinition factory: the '@root-name/...' prefix in
// params.path is resolved to an absolute path via the pure resolver, then a
// factory instance bound at that resolved path is delegated to with the
// absolute path. Everything else (label, parameters, promptSnippet,
// renderShell, prepareArguments) is spread from the base definition;
// renderCall/renderResult stay omitted so the built-in renderers are
// inherited automatically by tool name.
// Difference vs read/write/edit: grep/find/ls declare path as OPTIONAL (the
// search/list scope, defaulting to the bound cwd), so an absent path skips
// resolution entirely and delegates verbatim - the built-in default.
import {
  createBashTool,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveWorkspacePath, type RootInfo, type WorkspaceInfo } from "./path-resolver.ts";

export interface ToolDeps {
  getActive(): WorkspaceInfo | null;
  sessionCwd(): string; // getter, NOT a captured value: resolve at call time
  onFirstTouch(root: RootInfo, touchedPath?: string): string | null;
}

// Appended to every overridden tool's built-in description so the model
// learns the workspace path syntax from the tool schema itself.
const WORKSPACE_SYNTAX_NOTE =
  "\n\nWorkspace path syntax: when a workspace is active, prefix a path with " +
  "'@root-name/' to address a workspace root (for example '@backend/src/app.ts'). " +
  "Bare relative paths still resolve against the session start directory, and " +
  "absolute paths work unchanged. Unknown root names and '..' escapes are " +
  "reported as errors.";

// Appended to the built-in prompt guidelines (rendered into the system prompt).
const WORKSPACE_SYNTAX_GUIDELINE =
  "When a workspace is active, tool paths accept '@root-name/...' prefixes; " +
  "bare relative paths always resolve against the session start directory.";

// The slice of ToolDefinition this wrapper touches. The factories return full
// ToolDefinition objects; typing the spec against the used surface only keeps
// the three factories interchangeable.
interface FileToolDefinition {
  name: string;
  label: string;
  description: string;
  promptGuidelines?: string[];
  // Present on the factory-produced definitions; destructured away at
  // registration (see registerToolOverrides) so built-in renderers apply.
  renderCall?: unknown;
  renderResult?: unknown;
  execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any): Promise<any>;
}

interface FileToolSpec {
  name: string;
  factory(cwd: string): FileToolDefinition;
  // grep/find/ls: path is optional in the built-in schema and selects the
  // search/list scope; when omitted there is nothing to resolve and the
  // built-in default (the bound cwd) applies unchanged.
  pathOptional?: boolean;
}

const FILE_TOOL_SPECS: FileToolSpec[] = [
  { name: "read", factory: createReadToolDefinition },
  { name: "write", factory: createWriteToolDefinition },
  { name: "edit", factory: createEditToolDefinition },
  { name: "grep", factory: createGrepToolDefinition, pathOptional: true },
  { name: "find", factory: createFindToolDefinition, pathOptional: true },
  { name: "ls", factory: createLsToolDefinition, pathOptional: true },
];

export function registerToolOverrides(pi: any, deps: ToolDeps): void {
  for (const spec of FILE_TOOL_SPECS) {
    const base = spec.factory(deps.sessionCwd());
    const { execute: _baseExecute, renderCall: _omitRenderCall, renderResult: _omitRenderResult, ...rest } = base;
    pi.registerTool({
      ...rest,
      description: `${base.description}${WORKSPACE_SYNTAX_NOTE}`,
      promptGuidelines: [...(base.promptGuidelines ?? []), WORKSPACE_SYNTAX_GUIDELINE],
      execute: makeWorkspaceExecute(spec, deps),
    });
  }
  registerBashOverride(pi, deps);
}

function makeWorkspaceExecute(spec: FileToolSpec, deps: ToolDeps) {
  return async (
    toolCallId: string,
    params: { path: string } & Record<string, any>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ): Promise<any> => {
    if (typeof params.path !== "string") {
      // Optional-path tools (grep/find/ls) pass an ABSENT path straight
      // through: no '@root' to resolve, built-in default cwd applies. A
      // present-but-non-string path is a malformed call either way.
      if (params.path === undefined && spec.pathOptional) {
        const instance = spec.factory(deps.sessionCwd());
        return instance.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      throw new Error("params.path must be a string");
    }
    const resolved = resolveWorkspacePath(params.path, deps.getActive(), deps.sessionCwd());
    if (!resolved.ok) {
      // Throw, not an isError return: executeToolCall marks normal returns
      // isError:false and drops return-object isError, while a throw is
      // converted by the harness into the same content shape with
      // isError:true and a transcript error entry.
      throw new Error(resolved.error);
    }
    // Delegate on a factory instance bound at the resolved path, passing the
    // resolved absolute path. The base resolves absolute paths verbatim, so
    // the binding is a safety net for ctx-less invocation, not a behavior
    // change.
    //
    // Serialization note: the built-in write/edit execute already runs inside
    // withFileMutationQueue(absolutePath), keyed on this same resolved path.
    // The queue is NOT re-entrant (verified against dist: an outer same-key
    // wrap waits on its own release and deadlocks), so the override must not
    // wrap the delegation again; the built-in's internal queue provides the
    // write-serialization contract on the resolved absolute path.
    const instance = spec.factory(resolved.absolutePath);
    const result = await instance.execute(
      toolCallId,
      { ...params, path: resolved.absolutePath },
      signal,
      onUpdate,
      ctx,
    );
    if (resolved.root) {
      const note = deps.onFirstTouch(resolved.root, resolved.absolutePath);
      if (note !== null) {
        return { ...result, content: [{ type: "text", text: note }, ...result.content] };
      }
    }
    return result;
  };
}

// Description of the added cwd parameter; carries the workspace syntax so
// the model learns it from the tool schema itself (the bash override keeps
// the base tool description unchanged - the syntax note above talks about
// tool paths, which bash has none of).
const BASH_CWD_DESCRIPTION =
  "Working directory to run the command in (optional, defaults to the session start directory): " +
  "an absolute path, or '@root-name/sub/dir' to run inside a workspace root. " +
  "Unknown root names and '..' escapes are reported as errors.";

function registerBashOverride(pi: any, deps: ToolDeps): void {
  const base = createBashToolDefinition(deps.sessionCwd());
  const { execute: _baseExecute, renderCall: _omitRenderCall, renderResult: _omitRenderResult, ...rest } = base;
  // Superset of the built-in schema: same command/timeout property objects,
  // plus the optional cwd (order: built-ins first, cwd last).
  const parameters = Type.Object({
    ...(base.parameters as any).properties,
    cwd: Type.Optional(Type.String({ description: BASH_CWD_DESCRIPTION })),
  });
  pi.registerTool({
    ...rest,
    parameters,
    execute: makeBashExecute(deps),
  });
}

function makeBashExecute(deps: ToolDeps) {
  return async (
    toolCallId: string,
    params: { command: string; timeout?: number; cwd?: string } & Record<string, any>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ): Promise<any> => {
    const { cwd, ...bashParams } = params;
    let target: string;
    let root: RootInfo | null = null;
    // Tracks whether params.cwd went through the workspace resolver; only in
    // that case must ctx be withheld from the delegation (see below).
    const usedResolver = cwd !== undefined;
    if (cwd === undefined) {
      // No cwd: run in the session start directory, exactly like the built-in.
      target = deps.sessionCwd();
    } else {
      if (typeof cwd !== "string") {
        throw new Error("params.cwd must be a string");
      }
      const resolved = resolveWorkspacePath(cwd, deps.getActive(), deps.sessionCwd());
      if (!resolved.ok) {
        // Throw, not an isError return: executeToolCall converts throws into
        // isError:true results (same contract as the file-tool overrides).
        throw new Error(resolved.error);
      }
      target = resolved.absolutePath;
      root = resolved.root;
    }
    // Delegate to the AgentTool factory, NOT the ToolDefinition: the
    // definition's execute prefers ctx.cwd over the factory-bound cwd
    // (verified against dist: resolveSpawnContext(resolvedCommand,
    // ctx?.cwd || cwd, ...)), so passing the runtime ctx through would
    // silently discard the resolved target. The two branches differ:
    // - Resolver branch (cwd given): drop ctx, the factory-bound cwd is the
    //   single source of truth for the working directory.
    // - Default branch (no cwd): ctx.cwd === sessionCwd() === the factory's
    //   bound cwd, so passing ctx changes nothing for the cwd but restores
    //   the built-in's promptGuidelines contract (PI_* session env vars are
    //   only injected when ctx is present; without ctx they get deleted).
    // bash is stateless (a fresh process per call), so a per-call factory
    // instance bound at the target directory is cheap and safe.
    const tool = createBashTool(target);
    // AgentTool's type-level execute omits the ctx param, but the runtime
    // wrapper forwards it to the definition (verified against dist
    // tool-definition-wrapper.js); type the delegation against that real
    // 5-arg signature, same trick as FileToolDefinition above.
    const execute = tool.execute as (
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) => Promise<any>;
    const result = await execute(toolCallId, bashParams, signal, onUpdate, usedResolver ? undefined : ctx);
    if (root) {
      const note = deps.onFirstTouch(root, target);
      if (note !== null) {
        return { ...result, content: [{ type: "text", text: note }, ...result.content] };
      }
    }
    return result;
  };
}
