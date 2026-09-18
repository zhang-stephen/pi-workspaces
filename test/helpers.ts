// Test helpers: temp-dir fixtures plus mocks for the pi extension API.
// Type-only imports from the pi package are fully erased at runtime, so
// `node --test` does not need the package installed to load this module.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionEvent,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Create a fresh temporary directory. The caller is responsible for cleanup. */
export function makeTempDir(prefix = "pi-workspaces-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write content to `root/rel`, creating parent directories as needed. */
export function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * Minimal ExtensionCommandContext stub for exercising event and command
 * handlers headlessly. `hasUI` is false; every ui method is a no-op and
 * `ui.theme.fg` passes text through without ANSI colors.
 * Pass `extra` to override individual fields (e.g. a real sessionManager).
 */
export function mockCtx(cwd: string, extra: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  // Class-based stubs on purpose: pi's Theme and SessionManager are classes
  // whose methods dereference `this`. Extension code must call them bound -
  // a detached `ctx.ui.theme.fg` or cached `getEntries` reference throws, and
  // these stubs reproduce that (a plain arrow-function stub would not).
  class MockTheme {
    private fgColors = new Map<string, string>();
    fg(_color: string, text: string): string {
      void this.fgColors;
      return text;
    }
  }
  class MockSessionManager {
    private fileEntries: unknown[] = [];
    getSessionId(): string {
      return "test-session";
    }
    getSessionFile(): undefined {
      return undefined;
    }
    getEntries(): unknown[] {
      return this.fileEntries;
    }
  }
  const theme = new MockTheme();
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return {
    ui: ui as unknown as ExtensionCommandContext["ui"],
    mode: "print",
    hasUI: false,
    cwd,
    // Minimal sessionManager: the built-in bash tool dereferences
    // getSessionId/getSessionFile whenever a ctx is passed through (env
    // parity path), so the stub must be callable. getEntries feeds the
    // journal-restore branch of session_start.
    sessionManager: new MockSessionManager() as unknown as ExtensionCommandContext["sessionManager"],
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({}) as ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>,
    waitForIdle: () => Promise.resolve(),
    newSession: () => Promise.resolve({ cancelled: false }),
    fork: () => Promise.resolve({ cancelled: false }),
    navigateTree: () => Promise.resolve({ cancelled: false }),
    switchSession: () => Promise.resolve({ cancelled: false }),
    reload: () => Promise.resolve(),
    ...extra,
  };
}

type HandlerFn = (event: any, ctx: any) => unknown;

/**
 * ExtensionAPI stub that records registrations into maps. Intended use:
 * `const pi = mockPi(); factory(pi);` then inspect `pi.tools`,
 * `pi.commands`, `pi.handlers`, `pi.entries` or drive handlers via `emit`.
 * Only the API surface this project uses is implemented; anything else
 * fails loudly at call time.
 */
export function mockPi(): ExtensionAPI & {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, HandlerFn[]>;
  entries: Map<string, unknown[]>;
} {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, HandlerFn[]>();
  const entries = new Map<string, unknown[]>();
  const api = {
    on(event: string, handler: HandlerFn) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, { name, ...options } as RegisteredCommand);
    },
    appendEntry(customType: string, data?: unknown) {
      const list = entries.get(customType) ?? [];
      list.push(data);
      entries.set(customType, list);
    },
  };
  return { ...api, tools, commands, handlers, entries } as ExtensionAPI & {
    tools: Map<string, ToolDefinition>;
    commands: Map<string, RegisteredCommand>;
    handlers: Map<string, HandlerFn[]>;
    entries: Map<string, unknown[]>;
  };
}

/**
 * Invoke every handler registered for `event`, in registration order.
 * Returns the array of handler results.
 */
export async function emit<E extends ExtensionEvent>(
  handlers: Map<string, HandlerFn[]>,
  event: E["type"],
  payload: E,
  ctx: ExtensionCommandContext,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx));
  }
  return results;
}
