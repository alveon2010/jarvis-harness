import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndexConfig } from "../../core/config/schema.ts";
import { git } from "../../tools/local/exec.ts";
import { globMatches } from "../frontmatter.ts";
import { type KnowledgeUnit, unitVersion } from "./index.ts";

/**
 * Code in the full-text index (ADR-0015 §2 v0.4): tracked source files as semantic units — a
 * top-level declaration, or a member of a long one — never the whole repository in fixed chunks.
 * A unit's version is the file's blob sha (ADR-0008), so a file is read again only when git says
 * it changed; vendored, generated, binary and huge files stay out.
 */

/** Extensions of source code; configuration, data and lock files are not code to search by words. */
const CODE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs java kt kts scala groovy py rb go rs cs fs swift m mm c h cc cpp hpp " +
    "php vue svelte sql graphql gql proto sh dart ex exs erl clj lua"
  ).split(" "),
);

/** Folders that hold someone else's code or build output. */
const VENDORED =
  /(^|\/)(node_modules|vendor|vendors|third_party|dist|build|out|target|coverage|\.jarvis|\.git|\.next|\.nuxt|generated|__generated__|Pods|obj)\//;
/** Files a tool wrote. */
const GENERATED = /(\.min\.[cm]?js|\.d\.ts|\.generated\.[a-z]+|\.pb\.go|_pb2\.py|\.g\.dart)$/;

/** A unit longer than this is split by its members, then by windows. */
export const MAX_UNIT_LINES = 150;
const WINDOW_LINES = 100;

const MODIFIERS =
  "(?:(?:export|default|declare|public|private|protected|internal|static|final|abstract|sealed|open|override|async|suspend|inline|data|pub(?:\\([^)]*\\))?|unsafe|virtual|partial|readonly)\\s+)*";
const DECL = new RegExp(
  `^\\s*${MODIFIERS}(?:function\\*?|class|interface|type|enum|const|let|var|def|fun|func|fn|struct|trait|impl|object|record|module|namespace)\\s+([A-Za-z_$][\\w$]*)`,
);
/** A method: a name with parameters opening a body, at member indentation. */
const MEMBER =
  /^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|async|get|set|readonly)\s+)*(?:[\w<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(.*\)?[^;]*\{\s*$/;
const CONTROL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "new",
  "function",
]);

export interface CodeFile {
  readonly path: string;
  /** Blob sha of the index, or `wt:<content sha>` for a file changed in the working copy. */
  readonly version: string;
}

export interface CodeScan {
  /** Units of files that changed since they were indexed. */
  readonly units: KnowledgeUnit[];
  /** Source ids of files that did not change: kept as they are. */
  readonly keep: string[];
  readonly files: number;
  readonly changed: number;
  /** Over `maxFiles`, over `maxFileBytes`, binary or unreadable. */
  readonly skipped: number;
}

interface Segment {
  readonly name?: string;
  /** 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function declName(line: string): string | undefined {
  return DECL.exec(line)?.[1];
}

function memberName(line: string): string | undefined {
  const name = DECL.exec(line)?.[1] ?? MEMBER.exec(line)?.[1];
  return name && !CONTROL.has(name) ? name : undefined;
}

/** A declaration takes the comments and annotations right above it. */
function pullUp(lines: readonly string[], at: number, floor: number): number {
  let i = at;
  while (i - 1 > floor) {
    const prev = (lines[i - 1] as string).trim();
    if (/^(\/\/|\/\*|\*|#|@|"""|'''|\/\/\/)/.test(prev) && prev.length > 0) i -= 1;
    else break;
  }
  return i;
}

function windows(name: string | undefined, start: number, end: number): Segment[] {
  if (end - start + 1 <= MAX_UNIT_LINES) return [{ ...(name ? { name } : {}), start, end }];
  const out: Segment[] = [];
  for (let s = start, part = 1; s <= end; s += WINDOW_LINES, part += 1)
    out.push({
      name: `${name ?? "lines"} (part ${part})`,
      start: s,
      end: Math.min(end, s + WINDOW_LINES - 1),
    });
  return out;
}

/** A long declaration by its members (the shallowest ones), each still bounded by windows. */
function byMembers(lines: readonly string[], seg: Segment): Segment[] {
  if (seg.end - seg.start + 1 <= MAX_UNIT_LINES) return [seg];
  const found: Array<{ i: number; name: string; indent: number }> = [];
  for (let i = seg.start; i < seg.end; i += 1) {
    const line = lines[i] as string;
    if (indentOf(line) === 0) continue;
    const name = memberName(line);
    if (name) found.push({ i, name, indent: indentOf(line) });
  }
  if (found.length === 0) return windows(seg.name, seg.start, seg.end);
  const shallow = Math.min(...found.map((f) => f.indent));
  const members = found.filter((f) => f.indent === shallow);
  const out: Segment[] = [];
  const starts = members.map((m) => pullUp(lines, m.i, seg.start - 1) + 1);
  if ((starts[0] as number) > seg.start) out.push(...windows(seg.name, seg.start, (starts[0] as number) - 1));
  members.forEach((m, k) => {
    const end = k + 1 < members.length ? (starts[k + 1] as number) - 1 : seg.end;
    out.push(...windows(seg.name ? `${seg.name}.${m.name}` : m.name, starts[k] as number, end));
  });
  return out;
}

/** The file as units: top-level declarations, long ones by members; a file without any by windows. */
export function symbolSegments(text: string): Segment[] {
  const lines = text.split("\n");
  while (lines.length > 0 && (lines.at(-1) as string).trim() === "") lines.pop();
  if (lines.length === 0) return [];
  const tops: Array<{ i: number; name: string }> = [];
  lines.forEach((line, i) => {
    if (indentOf(line) !== 0) return;
    const name = declName(line);
    if (name) tops.push({ i, name });
  });
  if (tops.length === 0) return windows(undefined, 1, lines.length);
  const starts = tops.map((t, k) => pullUp(lines, t.i, k > 0 ? (tops[k - 1] as { i: number }).i : -1) + 1);
  const out: Segment[] = [];
  if ((starts[0] as number) > 1) {
    const head = lines.slice(0, (starts[0] as number) - 1).join("\n");
    if (head.trim().length > 0) out.push(...windows(undefined, 1, (starts[0] as number) - 1));
  }
  tops.forEach((t, k) => {
    const end = k + 1 < tops.length ? (starts[k + 1] as number) - 1 : lines.length;
    out.push(...byMembers(lines, { name: t.name, start: starts[k] as number, end }));
  });
  return out;
}

/** `canRestartOnboarding`, `can_restart` → `can restart onboarding`: FTS tokens do not split identifiers. */
export function identifierWords(text: string): string {
  const words = new Set<string>();
  for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (!/[a-z][A-Z]|_[A-Za-z]|[A-Z]{2}[a-z]/.test(id)) continue;
    for (const w of id
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_$]+/))
      if (w.length > 2) words.add(w.toLowerCase());
  }
  return [...words].join(" ");
}

/** The units of one file, each with a `path:start-end` ref. */
export function codeUnitsOf(path: string, version: string, text: string): KnowledgeUnit[] {
  const lines = text.split("\n");
  return symbolSegments(text).map((seg, i) => {
    const code = lines.slice(seg.start - 1, seg.end).join("\n");
    return {
      sourceId: `code:${path}#${i}`,
      sourceVersion: version,
      kind: "code" as const,
      title: seg.name ? `${path} — ${seg.name}` : path,
      ref: `${path}:${seg.start}-${seg.end}`,
      body: `${path}\n${identifierWords(`${path} ${code}`)}\n${code}`,
    };
  });
}

/** Whether the index takes this path at all (before reading it). */
export function isIndexableCode(
  path: string,
  config: Pick<CodeIndexConfig, "include" | "exclude">,
  isDenied?: (relative: string) => boolean,
): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!ext || !CODE_EXTENSIONS.has(ext)) return false;
  if (VENDORED.test(path) || GENERATED.test(path)) return false;
  if (config.include.length > 0 && !globMatches(path, config.include)) return false;
  if (config.exclude.length > 0 && globMatches(path, config.exclude)) return false;
  return !isDenied?.(path);
}

/** Tracked files with their blob shas; those changed in the working copy versioned by content. */
export async function trackedFiles(root: string): Promise<CodeFile[]> {
  const listed = await git(["ls-files", "-s", "-z"], root);
  if (listed.code !== 0) return [];
  const modified = await git(["ls-files", "-m", "-z"], root);
  const changed = new Set(modified.code === 0 ? modified.stdout.split("\0").filter(Boolean) : []);
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t") as [string, string];
      return { path, version: changed.has(path) ? "" : (meta.split(" ")[1] as string) };
    });
}

/**
 * What the index needs of the repository: units of changed files, ids of unchanged ones. `known`
 * maps a path to the version its units were indexed at.
 */
export async function scanCode(
  root: string,
  config: CodeIndexConfig,
  known: ReadonlyMap<string, { version: string; ids: string[] }>,
  isDenied?: (relative: string) => boolean,
): Promise<CodeScan> {
  const all = await trackedFiles(root);
  const files = all.filter((f) => isIndexableCode(f.path, config, isDenied));
  const taken = files.slice(0, config.maxFiles);
  let skipped = files.length - taken.length;
  const units: KnowledgeUnit[] = [];
  const keep: string[] = [];
  let changed = 0;
  for (const f of taken) {
    const prev = known.get(f.path);
    if (f.version && prev?.version === f.version) {
      keep.push(...prev.ids);
      continue;
    }
    const absolute = join(root, f.path);
    let text: string;
    try {
      if (statSync(absolute).size > config.maxFileBytes) {
        skipped += 1;
        continue;
      }
      text = readFileSync(absolute, "utf8");
    } catch {
      skipped += 1; // deleted in the working copy
      continue;
    }
    if (text.slice(0, 8000).includes("\0")) {
      skipped += 1;
      continue;
    }
    const version = f.version || `wt:${unitVersion(text)}`;
    if (prev?.version === version) {
      keep.push(...prev.ids);
      continue;
    }
    units.push(...codeUnitsOf(f.path, version, text));
    changed += 1;
  }
  return { units, keep, files: taken.length, changed, skipped };
}
