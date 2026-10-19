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

/* ---- JavaScript: jest, vitest, mocha ---- */

export type JsRunner = "jest" | "vitest" | "mocha";

export interface JsRunnerOf {
  readonly runner: JsRunner;
  /** Arguments reach the runner only after `--` (an npm script). */
  readonly dashDash: boolean;
}

const RUNNER_WORD = /\b(vitest|jest|mocha)\b/;

/**
 * The JavaScript test runner a `test*` command ends in: named in it (`npx jest`), or behind a package
 * script (`yarn test`, `npm run test:unit`) — the script in the package's `package.json`.
 */
export function jsRunnerOf(command: string, workspace: string): JsRunnerOf | undefined {
  const named = RUNNER_WORD.exec(command)?.[1] as JsRunner | undefined;
  if (named) return { runner: named, dashDash: false };
  const m = /(?:^|&&\s*)(npm|yarn|pnpm|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(command.trim());
  if (!m) return undefined;
  const [, pm, script] = m as unknown as [string, string, string];
  const dir = /^\s*cd\s+([^\s&;]+)\s*&&/.exec(command)?.[1] ?? ".";
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const body = pkg.scripts?.[script === "t" ? "test" : script] ?? "";
    const runner = RUNNER_WORD.exec(body)?.[1] as JsRunner | undefined;
    return runner ? { runner, dashDash: pm === "npm" } : undefined;
  } catch {
    return undefined;
  }
}

/** The runner's own arguments that write its JSON report to `file`, besides its usual output. */
export function reporterArgs(runner: JsRunner, file: string): string {
  if (runner === "jest") return `--json --outputFile=${file}`;
  if (runner === "vitest") return `--reporter=default --reporter=json --outputFile=${file}`;
  return `--reporter=json --reporter-option=output=${file}`;
}

/** An option the runner does not know: the report is dropped, the command runs as it was. */
export const UNKNOWN_OPTION =
  /unknown (option|argument)|unrecognized (option|argument)|unexpected argument|invalid option/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colours in runner output
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** JavaScript frames in the project: `at fn (src/a.ts:12:5)`, `❯ src/a.test.ts:12:5`. */
export function jsFrames(text: string, workspace: string): StackFrame[] {
  const out: StackFrame[] = [];
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  for (const raw of stripAnsi(text).split("\n")) {
    const m =
      /^\s*at\s+(?:(.+?)\s+\()?(?:file:\/\/)?([^()\s]+?):(\d+)(?::\d+)?\)?\s*$/.exec(raw) ??
      /^\s*❯\s+(?:(\S+)\s+)?(?:file:\/\/)?([^\s()]+?):(\d+)(?::\d+)?\s*$/.exec(raw);
    if (!m) continue;
    let file = m[2] as string;
    if (/node_modules|^node:|^internal\//.test(file)) continue;
    if (file.startsWith(root)) file = file.slice(root.length);
    out.push({ file, line: Number(m[3]), ...(m[1] ? { fn: m[1] } : {}), raw: raw.trim() });
  }
  return out;
}

/** Expected and actual in the JavaScript wordings: jest's and chai's (vitest). */
export function jsExpectedActual(message: string): { expected?: string; actual?: string } {
  const text = stripAnsi(message);
  const chai = /expected (.+?) to (?:be|equal|strictly equal|deeply equal|eql) (.+?)(?:\s+\/\/.*)?$/m.exec(
    text,
  );
  if (chai) return { expected: (chai[2] as string).trim(), actual: (chai[1] as string).trim() };
  const diff = /- Expected[^\n]*\n\+ Received[^\n]*\n\s*\n\s*- ([^\n]+)\n\s*\+ ([^\n]+)/.exec(text);
  if (diff) return { expected: (diff[1] as string).trim(), actual: (diff[2] as string).trim() };
  return expectedActualOf(text);
}

const relativeTo = (file: string, workspace: string): string => {
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
};

/** A jest (or vitest: the same shape) JSON report. */
export function parseJestJson(json: unknown, workspace: string): TestReport {
  const doc = (json ?? {}) as {
    numTotalTests?: number;
    testResults?: Array<{
      name?: string;
      status?: string;
      message?: string;
      assertionResults?: Array<{
        status?: string;
        title?: string;
        ancestorTitles?: string[];
        failureMessages?: string[];
      }>;
    }>;
  };
  const failures: TestFailure[] = [];
  for (const file of doc.testResults ?? []) {
    const path = file.name ? relativeTo(file.name, workspace) : undefined;
    const failed = (file.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) {
      const text = stripAnsi((a.failureMessages ?? []).join("\n"));
      failures.push({
        ...(a.ancestorTitles && a.ancestorTitles.length > 0 ? { suite: a.ancestorTitles.join(" › ") } : {}),
        name: a.title ?? "(unnamed)",
        ...(path ? { file: path } : {}),
        message: messageOf(text),
        ...jsExpectedActual(text),
        stack: jsFrames(text, workspace),
      });
    }
    // a file that did not run at all (a syntax error, a failed import): its message is the failure
    if (failed.length === 0 && file.status === "failed" && file.message) {
      const text = stripAnsi(file.message);
      failures.push({
        name: "the test file failed to run",
        ...(path ? { file: path } : {}),
        message: messageOf(text),
        stack: jsFrames(text, workspace),
      });
    }
  }
  return {
    source: "json",
    failures,
    ...(doc.numTotalTests !== undefined ? { total: doc.numTotalTests } : {}),
  };
}

/** A mocha JSON report. */
export function parseMochaJson(json: unknown, workspace: string): TestReport {
  const doc = (json ?? {}) as {
    stats?: { tests?: number };
    failures?: Array<{
      title?: string;
      fullTitle?: string;
      file?: string;
      err?: { message?: string; stack?: string; expected?: unknown; actual?: unknown };
    }>;
  };
  const failures: TestFailure[] = (doc.failures ?? []).map((f) => {
    const text = stripAnsi(`${f.err?.message ?? ""}\n${f.err?.stack ?? ""}`);
    const suite = f.fullTitle && f.title ? f.fullTitle.slice(0, -f.title.length).trim() : undefined;
    const expected = f.err?.expected !== undefined ? JSON.stringify(f.err.expected) : undefined;
    const actual = f.err?.actual !== undefined ? JSON.stringify(f.err.actual) : undefined;
    return {
      ...(suite ? { suite } : {}),
      name: f.title ?? "(unnamed)",
      ...(f.file ? { file: relativeTo(f.file, workspace) } : {}),
      message: messageOf(f.err?.message ?? text),
      ...(expected !== undefined && actual !== undefined ? { expected, actual } : jsExpectedActual(text)),
      stack: jsFrames(f.err?.stack ?? "", workspace),
    };
  });
  return { source: "json", failures, ...(doc.stats?.tests !== undefined ? { total: doc.stats.tests } : {}) };
}

/**
 * The failures in a jest or vitest run's printed output, when no JSON report came (a wrapper script,
 * a runner too old for the reporter): jest's `● Suite › test` blocks, vitest's `FAIL file > suite > test`.
 */
export function parseJsText(output: string, workspace: string): TestReport | undefined {
  const lines = stripAnsi(output).split("\n");
  const failures: TestFailure[] = [];
  let current: { head: string; file?: string; body: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.body.join("\n");
    const parts = current.head.split(/\s+[›>]\s+/);
    const name = parts.at(-1) ?? current.head;
    const suite = parts.slice(0, -1).join(" › ");
    failures.push({
      ...(suite ? { suite } : {}),
      name,
      ...(current.file ? { file: current.file } : {}),
      message: messageOf(text),
      ...jsExpectedActual(text),
      stack: jsFrames(text, workspace),
    });
    current = undefined;
  };
  for (const line of lines) {
    const jest = /^\s{0,4}● (.+)$/.exec(line);
    const vitest = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+)$/.exec(line);
    if (jest && !/^Console$/.test(jest[1] as string)) {
      flush();
      current = { head: (jest[1] as string).trim(), body: [] };
    } else if (vitest) {
      flush();
      current = { head: (vitest[2] as string).trim(), file: vitest[1] as string, body: [] };
    } else if (/^\s*(Test Suites:|Tests:|Test Files\s|⎯{3,}|Snapshots:)/.test(line)) {
      flush();
    } else if (current) current.body.push(line);
  }
  flush();
  return failures.length > 0 ? { source: "text", failures } : undefined;
}
