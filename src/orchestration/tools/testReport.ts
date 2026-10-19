import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StackFrame, TestFailure, TestReport } from "../../core/capabilities/contracts.ts";

/**
 * Why tests failed, as data: each failed test with its message, what was expected and what came,
 * and its stack. Read from the reports the runners write (JUnit XML for Gradle and Maven), so a
 * person sees the failure itself, and the agent that fixes it gets the place, not the runner's summary.
 * Pilot: the reasons of a failed check were its last three lines — «Tests: 2 failed, 12 passed».
 */
export type { StackFrame, TestFailure, TestReport } from "../../core/capabilities/contracts.ts";

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? xmlText(m[1] as string) : undefined;
};

/** «expected: <true> but was: <false>» (JUnit, AssertJ, opentest4j, Hamcrest). */
export function expectedActualOf(message: string): { expected?: string; actual?: string } {
  const patterns: RegExp[] = [
    /expected:\s*<([\s\S]*?)>\s*but was:\s*<([\s\S]*?)>/i,
    /expected:\s*([^\n]+?)\s*\n?\s*but was:\s*([^\n]+)/i,
    /Expected:\s*([^\n]+)\n\s*Received:\s*([^\n]+)/,
    /expected:?\s*"?([^\n"]+)"?\s*\n\s*(?:but )?(?:was|got|actual):?\s*"?([^\n"]+)"?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (m) return { expected: (m[1] as string).trim(), actual: (m[2] as string).trim() };
  }
  return {};
}

/** Java frames: `at a.b.Service.method(Service.java:42)`. */
export function javaFrames(text: string): StackFrame[] {
  const out: StackFrame[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^:()]+)(?::(\d+))?\)/.exec(line);
    if (!m) continue;
    const cls = (m[1] as string).replace(/\$.*$/, "");
    out.push({
      file: cls,
      fn: m[2] as string,
      ...(m[4] ? { line: Number(m[4]) } : {}),
      raw: line.trim(),
    });
  }
  return out;
}

/** The first meaningful lines of a failure's text, without its stack. */
export function messageOf(text: string, max = 6): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0 && !/^\s*at\s/.test(l) && !/^\s*\.\.\. \d+ more/.test(l));
  return lines.slice(0, max).join("\n").slice(0, 2000);
}

/** The failed test cases of one JUnit XML report. */
export function parseJunitXml(xml: string): TestReport {
  const failures: TestFailure[] = [];
  let total = 0;
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const c of cases) {
    total++;
    const open = c[1] ?? "";
    const body = c[2] ?? "";
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!f) continue;
    const head = attr(f[2] ?? "", "message") ?? "";
    const type = attr(f[2] ?? "", "type");
    const text = xmlText(f[3] ?? "");
    const message = messageOf(text) || [type, head].filter(Boolean).join(": ");
    const suite = attr(open, "classname");
    const file = attr(open, "file");
    failures.push({
      ...(suite ? { suite } : {}),
      name: attr(open, "name") ?? "(unnamed)",
      ...(file ? { file } : {}),
      message,
      ...expectedActualOf(`${head}\n${text}`),
      stack: javaFrames(text),
    });
  }
  return { source: "junit", failures, total };
}

const REPORT_DIRS = /(^|\/)(build\/test-results|target\/(surefire|failsafe)-reports)(\/|$)/;
const SKIP = new Set(["node_modules", ".git", ".gradle", "src"]);

/** The failures of every JUnit XML report written under `root` since `since` (ms). */
export function junitTestFailures(root: string, since: number): TestReport | undefined {
  const failures: TestFailure[] = [];
  let total = 0;
  let found = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, r, depth + 1);
        else if (REPORT_DIRS.test(r) && /^TEST-.+\.xml$/.test(name) && st.mtimeMs >= since) {
          found = true;
          const report = parseJunitXml(readFileSync(abs, "utf8"));
          failures.push(...report.failures);
          total += report.total ?? 0;
        }
      } catch {
        // gone while reading
      }
    }
  };
  walk(root, "", 0);
  return found ? { source: "junit", failures, total } : undefined;
}

/* ---- In the project: frames, the lines the run changed, the reasons ---- */

export interface ProjectFrame extends StackFrame {
  /** The line is one the run added or changed. */
  readonly changed?: boolean;
}

export interface PlacedFailure extends Omit<TestFailure, "stack"> {
  /** Frames in the project's own files, the runner's and libraries' left out. */
  readonly stack: readonly ProjectFrame[];
  /** How many frames were left out. */
  readonly hidden: number;
  readonly preexisting?: boolean;
}

/** Lines the run added or changed, per file: `git diff -U0` hunks, new side. */
export function changedLinesOf(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      file = f[1] as string;
      continue;
    }
    if (/^\+\+\+ \/dev\/null/.test(line)) {
      file = undefined;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count === 0) continue;
      const ranges = out.get(file) ?? [];
      ranges.push([start, start + count - 1]);
      out.set(file, ranges);
    }
  }
  return out;
}

/**
 * A failure's frames in the project: a Java class to its source file (`a.b.Service` →
 * `src/main/java/a/b/Service.java`), a JavaScript file as it is when the checkout has it; each
 * marked when its line is one the run changed.
 */
export function placeFailure(
  f: TestFailure & { preexisting?: boolean },
  files: readonly string[],
  changed: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): PlacedFailure {
  const known = new Set(files);
  const bySuffix = (cls: string): string | undefined => {
    const stem = `/${cls.split(".").join("/")}.`;
    return files.find((p) => `/${p}`.includes(stem) && /\.(java|kt|groovy|scala)$/.test(p));
  };
  const stack: ProjectFrame[] = [];
  for (const fr of f.stack) {
    const file = known.has(fr.file)
      ? fr.file
      : /^[\w$]+(\.[\w$]+)+$/.test(fr.file)
        ? bySuffix(fr.file)
        : undefined;
    if (!file) continue;
    const hit =
      fr.line !== undefined &&
      (changed.get(file) ?? []).some(([a, b]) => (fr.line as number) >= a && (fr.line as number) <= b);
    if (stack.some((s) => s.file === file && s.line === fr.line)) continue;
    stack.push({ ...fr, file, ...(hit ? { changed: true } : {}) });
  }
  const { stack: all, ...rest } = f;
  return { ...rest, stack, hidden: all.length - stack.length };
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The reasons a failed test check sends the implementation back with: one per failed test of this
 * run (up to `max`), with its message, what was expected and what came, and where — the line the run
 * changed first. Pre-existing failures are not the run's to fix.
 */
export function failureReasons(
  check: string,
  failures: readonly PlacedFailure[],
  max = 5,
): Array<{ kind: string; summary: string; sourceRefs: string[] }> {
  const own = failures.filter((f) => !f.preexisting);
  const reasons = own.slice(0, max).map((f) => {
    const at = f.stack.find((s) => s.changed) ?? f.stack[0];
    const where = at
      ? `${at.file}${at.line ? `:${at.line}` : ""}${at.changed ? " (changed by this run)" : ""}`
      : f.file;
    const title = [f.suite, f.name].filter(Boolean).join(" › ");
    const ea =
      f.expected !== undefined && f.actual !== undefined
        ? `; expected ${oneLine(f.expected, 80)}, got ${oneLine(f.actual, 80)}`
        : "";
    return {
      kind: "defects_found",
      summary: `${check}: test "${oneLine(title, 160)}" failed: ${oneLine(f.message.split("\n")[0] ?? "", 200)}${ea}${where ? ` — at ${where}` : ""}`,
      sourceRefs: [
        `check:${check}`,
        ...f.stack.slice(0, 3).map((s) => (s.line ? `${s.file}:${s.line}` : s.file)),
      ],
    };
  });
  if (own.length > max)
    reasons.push({
      kind: "defects_found",
      summary: `${check}: ${own.length - max} more failed: ${own
        .slice(max, max + 8)
        .map((f) => oneLine(f.name, 60))
        .join(", ")}`,
      sourceRefs: [`check:${check}`],
    });
  return reasons;
}
