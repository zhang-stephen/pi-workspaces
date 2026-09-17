// Tool overrides for the file tools read/write/edit (grep/find/ls and bash
// follow in later tasks; FILE_TOOL_SPECS is the single extension point).
// Each override is a thin wrapper around the built-in definition produced by
// pi's createXxxToolDefinition factory: the '@root-name/...' prefix in
// params.path is resolved to an absolute path via the pure resolver, then a
// factory instance bound at that resolved path is delegated to with the
// absolute path. Everything else (label, parameters, promptSnippet,
// renderShell, prepareArguments) is spread from the base definition;
// renderCall/renderResult stay omitted so the built-in renderers are
// inherited automatically by tool name.
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath, type RootInfo, type WorkspaceInfo } from "./path-resolver.ts";

export interface ToolDeps {
  getActive(): WorkspaceInfo | null;
  sessionCwd(): string; // getter, NOT a captured value: resolve at call time
  onFirstTouch(root: RootInfo): string | null;
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
}

const FILE_TOOL_SPECS: FileToolSpec[] = [
  { name: "read", factory: createReadToolDefinition },
  { name: "write", factory: createWriteToolDefinition },
  { name: "edit", factory: createEditToolDefinition },
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
}

function makeWorkspaceExecute(spec: FileToolSpec, deps: ToolDeps) {
  return async (
    toolCallId: string,
    params: { path: string } & Record<string, any>,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ): Promise<any> => {
    const resolved = resolveWorkspacePath(String(params.path), deps.getActive(), deps.sessionCwd());
    if (!resolved.ok) {
      return { content: [{ type: "text", text: resolved.error }], isError: true };
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
      const note = deps.onFirstTouch(resolved.root);
      if (note !== null) {
        return { ...result, content: [{ type: "text", text: note }, ...result.content] };
      }
    }
    return result;
  };
}
