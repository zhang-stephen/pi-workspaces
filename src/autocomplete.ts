// Editor @root autocomplete provider. The pure helpers (parseAtToken,
// completeRootNames, completeInRoot) are unit-tested; createAutocomplete
// Provider stacks them on top of the built-in slash/path completion.
// Task 12 registers the returned factory via ctx.ui.addAutocompleteProvider.
import * as fs from "node:fs";
import * as path from "node:path";
import { isInside, type RootInfo, type WorkspaceInfo } from "./path-resolver.ts";

export interface CompletionItem {
  label: string;
  description?: string;
}

// Entries never offered: noisy, and rarely an intentional @root target.
const SKIPPED_ENTRIES = new Set(["node_modules", ".git"]);
const MAX_SUGGESTIONS = 50;

// "@" only counts at a token boundary (line start or after whitespace), so
// "a@b.com" never triggers. The token runs to the cursor with no spaces or
// second "@" inside.
const AT_TOKEN = /(?:^|[ \t])@([^\s@]*)$/;

/**
 * Extract the "@root" token from the text before the cursor, or null when
 * the cursor is not in such a token. `pathPart` is null in stage 1 (completing
 * the root name itself); a string (possibly empty) in stage 2.
 */
export function parseAtToken(before: string): { rootPart: string; pathPart: string | null } | null {
  const match = AT_TOKEN.exec(before);
  if (!match) return null;
  const token = match[1];
  const sep = token.search(/[/\\]/);
  if (sep === -1) return { rootPart: token, pathPart: null };
  return { rootPart: token.slice(0, sep), pathPart: token.slice(sep + 1) };
}

/**
 * Root switchers: one item per root whose name matches `prefix`
 * (case-insensitive, following pi's own completion convention). The label
 * is the bare `name/` shown in the candidate list (the `@` exists only in
 * user input; the trailing slash makes pi treat the item as a directory -
 * accepting it re-triggers completion straight into the root). The
 * description carries the root's absolute path.
 */
export function completeRootNames(ws: WorkspaceInfo, prefix: string): CompletionItem[] {
  const lower = prefix.toLowerCase();
  return ws.roots
    .filter((root) => root.name.toLowerCase().startsWith(lower))
    .map((root) => ({ label: `${root.name}/`, description: root.path }));
}

/**
 * Stage 2: entries inside "@root/<pathPart>". The fragment after the last
 * separator filters names within its directory; directories get a "/"
 * suffix, "node_modules"/".git" are skipped, results are sorted by name and
 * capped at 50. Any unreadable or nonexistent directory yields [].
 */
export function completeInRoot(root: RootInfo, pathPart: string): CompletionItem[] {
  const { dir, fragment } = splitPathPart(pathPart);
  const targetDir = dir === "" ? root.path : path.join(root.path, dir);
  // Same lexical containment rule as the resolver: completion must never
  // list outside the root (e.g. via ".." segments).
  if (!isInside(root.path, targetDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !SKIPPED_ENTRIES.has(entry.name))
    .filter((entry) => entry.name.startsWith(fragment))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => ({ label: entry.isDirectory() ? `${entry.name}/` : entry.name }));
}

/** Split a stage-2 path part at its last separator: `dir` is listed, `fragment` filters. */
function splitPathPart(pathPart: string): { dir: string; fragment: string } {
  const idx = Math.max(pathPart.lastIndexOf("/"), pathPart.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", fragment: pathPart };
  return { dir: pathPart.slice(0, idx), fragment: pathPart.slice(idx + 1) };
}

// Minimal structural view of the pi-tui autocomplete contract (pi docs,
// "Autocomplete Providers"). Declared locally so this module needs no pi-tui
// import; the pinned return type is `any` and Task 12 passes the factory to
// ctx.ui.addAutocompleteProvider.
interface AutocompleteItemOut {
  value: string;
  label: string;
  description?: string;
}

interface AutocompleteProviderOut {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: AutocompleteItemOut[]; prefix: string } | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItemOut,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/**
 * Build an AutocompleteProviderFactory layered on the built-in provider.
 * Non-@ input, or any @ input with no active workspace, delegates to the
 * built-in provider untouched. @ tokens with an active workspace are owned
 * by this layer: stage 1 suggests "@name" per root, stage 2 suggests entries
 * inside the named root. Unknown roots yield an empty list (an empty result
 * hides the popup) rather than fuzzy file matches from the built-in layer.
 */
export function createAutocompleteProvider(getActive: () => WorkspaceInfo | null): any {
  return (current: AutocompleteProviderOut): AutocompleteProviderOut => ({
    triggerCharacters: ["@"],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const parsed = parseAtToken(before);
      // Quoted @-mentions ("@\"doc") are file attachments owned by the
      // built-in provider, not @root syntax; the rootPart regex would
      // swallow the quote, so hand the token back untouched.
      const ws = parsed && !parsed.rootPart.startsWith('"') ? getActive() : null;
      if (!parsed || !ws) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // Reconstructed with "/": same length as the typed token (both
      // separators are one char), so the built-in applyCompletion slices
      // the exact token off the line; value replaces it canonically.
      const prefix = `@${parsed.rootPart}${parsed.pathPart === null ? "" : `/${parsed.pathPart}`}`;
      if (parsed.pathPart === null) {
        const items = completeRootNames(ws, parsed.rootPart).map((item) => ({
          value: `@${item.label}`,
          label: item.label,
          description: item.description,
        }));
        return { items, prefix };
      }
      const root = ws.roots.find((candidate) => candidate.name === parsed.rootPart);
      if (!root) {
        return { items: [], prefix };
      }
      const dir = splitPathPart(parsed.pathPart).dir.replace(/\\/g, "/");
      const base = dir === "" ? `@${root.name}/` : `@${root.name}/${dir}/`;
      const items = completeInRoot(root, parsed.pathPart).map((item) => ({
        value: `${base}${item.label}`,
        label: item.label,
      }));
      return { items, prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  });
}
