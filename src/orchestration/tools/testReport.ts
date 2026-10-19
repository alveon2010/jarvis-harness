import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Why tests failed, as data: each failed test with its message, what was expected and what came,
 * and its stack. Read from the reports the runners write (JUnit XML for Gradle and Maven), so a
 * person sees the failure itself, and the agent that fixes it gets the place, not the runner's summary.
 * Pilot: the reasons of a failed check were its last three lines — «Tests: 2 failed, 12 passed».
 */
export interface StackFrame {
  /** As the runner wrote it: a file (`src/a.ts`, `OrderService.java`) or a class (`a.b.OrderService`). */
  readonly file: string;
  readonly line?: number;
  readonly fn?: string;
  /** The frame's line as printed. */
  readonly raw: string;
}

export interface TestFailure {
  /** The suite or test class. */
  readonly suite?: string;
  readonly name: string;
  /** The test's file, when the report names it. */
  readonly file?: string;
  /** The first lines of the failure: the assertion or the error. */
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly stack: readonly StackFrame[];
}

export interface TestReport {
  readonly source: "junit" | "json" | "text";
  readonly failures: readonly TestFailure[];
  /** Tests run, when the report says. */
  readonly total?: number;
}

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
