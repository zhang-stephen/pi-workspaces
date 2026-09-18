// Editor @root autocomplete provider. The pure helpers (parseAtToken,
// completeRootNames, completeInRoot) are unit-tested; createAutocomplete
// Provider stacks them on top of the built-in slash/path completion.
// Interaction model (2026-09-19 redesign): "@" offers root switchers (bare
// "name/" labels with absolute-path descriptions) plus the entries of the
// current root (the root containing the session directory); a token whose
// first segment names a root keeps the original explicit "@root/..."
// drill-down; any other token is completed as a path inside the current
// root. Labels never carry "@"; values always insert the explicit
// "@rootname/path" form. index.ts registers the returned factory via
// ctx.ui.addAutocompleteProvider.
import * as fs from "node:fs";
import * as path from "node:path";
import { isInside, owningRoot, type RootInfo, type WorkspaceInfo } from "./path-resolver.ts";

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
 * Entries inside a root for a given path part. The fragment after the last
 * separator filters names within its directory (case-insensitive,
 * following pi's own completion convention); directories get a "/"
 * suffix, "node_modules"/".git" are skipped, results are sorted by name
 * and capped at 50. Each item's description carries the path relative to
 * the root. Any unreadable or nonexistent directory yields [].
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
  const relDir = dir.replace(/\\/g, "/");
  const lower = fragment.toLowerCase();
  return entries
    .filter((entry) => !SKIPPED_ENTRIES.has(entry.name))
    .filter((entry) => entry.name.toLowerCase().startsWith(lower))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => ({
      label: entry.isDirectory() ? `${entry.name}/` : entry.name,
      description: relDir === "" ? entry.name : `${relDir}/${entry.name}`,
    }));
}

/** Split a path part at its last separator: `dir` is listed, `fragment` filters. */
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

/** Map a root's CompletionItems to provider items with explicit values. */
function rootEntryItems(root: RootInfo, pathPart: string): AutocompleteItemOut[] {
  const dir = splitPathPart(pathPart).dir.replace(/\\/g, "/");
  const base = dir === "" ? `@${root.name}/` : `@${root.name}/${dir}/`;
  return completeInRoot(root, pathPart).map((item) => ({
    value: `${base}${item.label}`,
    label: item.label,
    description: item.description,
  }));
}

/**
 * Build an AutocompleteProviderFactory layered on the built-in provider.
 * Non-@ input, or any @ input with no active workspace, delegates to the
 * built-in provider untouched. @ tokens with an active workspace are owned
 * by this layer: a token whose first segment names a root drills into that
 * root explicitly; any other token completes inside the current root (the
 * root containing the session cwd), with root switchers offered alongside
 * on slash-free tokens. Unknown roots and root-less paths without a
 * current root yield an empty list (an empty result hides the popup)
 * rather than fuzzy file matches from the built-in layer.
 */
export function createAutocompleteProvider(getActive: () => WorkspaceInfo | null, sessionCwd: string): any {
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
      // Explicit root: the segment before the first separator names a root
      // verbatim - the original drill-down logic, untouched.
      const explicitRoot =
        parsed.pathPart === null ? undefined : ws.roots.find((candidate) => candidate.name === parsed.rootPart);
      if (parsed.pathPart !== null && explicitRoot) {
        return { items: rootEntryItems(explicitRoot, parsed.pathPart), prefix };
      }

      const currentRoot = owningRoot(ws, sessionCwd);
      if (parsed.pathPart !== null) {
        // Root-less path ("@tex/ch" where tex is no root): complete inside
        // the current root; without one there is nothing to offer.
        if (!currentRoot) return { items: [], prefix };
        return { items: rootEntryItems(currentRoot, `${parsed.rootPart}/${parsed.pathPart}`), prefix };
      }

      // Slash-free token: root switchers first, then the current root's
      // top-level entries (A1). Both groups filter by the typed prefix.
      const switchers = completeRootNames(ws, parsed.rootPart).map((item) => ({
        value: `@${item.label}`,
        label: item.label,
        description: item.description,
      }));
      const entries = currentRoot ? rootEntryItems(currentRoot, parsed.rootPart) : [];
      return { items: [...switchers, ...entries], prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  });
}
