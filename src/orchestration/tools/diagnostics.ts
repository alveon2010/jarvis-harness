import type { Diagnostic } from "../../core/capabilities/contracts.ts";

/**
 * Diagnostics read from what a project's typecheck and lint commands print (ADR-0021 §4, the port's
 * `getDiagnostics`): file, line, column, severity, code, message — the same shape for every stack, so an
 * agent asks «what is wrong in the files I changed» and gets facts instead of reading a log. The forms
 * recognised are the common ones; a line in none of them is left out (the command's whole output is in its
 * own tool call).
 */
const FORMS: ReadonlyArray<{
  readonly re: RegExp;
  readonly to: (m: RegExpExecArray, source: string) => Diagnostic | undefined;
}> = [
  // tsc: src/a.ts(12,5): error TS2322: Type …
  {
    re: /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/,
    to: (m, source) => at(m[1], m[2], m[3], m[4], m[6], source, m[5]),
  },
  // tsc --pretty / vue-tsc: src/a.ts:12:5 - error TS2322: Type …
  {
    re: /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.+)$/,
    to: (m, source) => at(m[1], m[2], m[3], m[4], m[6], source, m[5]),
  },
  // kotlinc / gradle: e: file:///…/Order.kt:12:5 Unresolved reference: total
  {
    re: /^([ew]):\s+(?:file:\/\/)?(.+?):(\d+):(\d+)\s+(.+)$/,
    to: (m, source) => at(m[2], m[3], m[4], m[1] === "e" ? "error" : "warning", m[5], source),
  },
  // javac: src/main/java/Order.java:12: error: cannot find symbol
  {
    re: /^(.+?\.java):(\d+):\s+(error|warning):\s+(.+)$/,
    to: (m, source) => at(m[1], m[2], undefined, m[3], m[4], source),
  },
  // gcc-like, go vet, ruff, many linters: src/a.go:12:5: error: … / src/a.py:12:5: E501 line too long
  {
    re: /^([^\s:]+\.\w+):(\d+):(\d+):\s+(?:(error|warning|note|info)\s*:?\s+)?(?:([A-Z]+\d+)\s+)?(.+)$/,
    to: (m, source) => at(m[1], m[2], m[3], m[4] ?? "error", m[6], source, m[5]),
  },
];

function at(
  file: string | undefined,
  line: string | undefined,
  column: string | undefined,
  severity: string | undefined,
  message: string | undefined,
  source: string,
  code?: string,
): Diagnostic | undefined {
  if (!file || !line || !message) return undefined;
  const startLine = Number(line);
  return {
    severity:
      severity === "warning" ? "warning" : severity === "note" || severity === "info" ? "info" : "error",
    message: message.trim(),
    range: {
      file: file.trim().replace(/^\.\//, ""),
      startLine,
      endLine: startLine,
      ...(column ? { startColumn: Number(column) } : {}),
    },
    ...(code ? { code } : {}),
    source,
  };
}

// the «stylish» form of JS linters: a file line, then «  12:5  error  message  rule» under it
function stylish(lines: readonly string[], source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let file: string | undefined;
  for (const line of lines) {
    if (/^\S.*\.\w+$/.test(line) && !line.includes(" ")) {
      file = line;
      continue;
    }
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(line);
    if (file && m) {
      const d = at(file, m[1], m[2], m[3], m[4], source, m[5]);
      if (d) out.push(d);
    } else if (!line.trim()) file = undefined;
  }
  return out;
}

export function parseDiagnostics(output: string, source: string): Diagnostic[] {
  const lines = output
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n");
  const out: Diagnostic[] = [];
  for (const line of lines) {
    // the command line a tool's output starts with (`$ tsc --noEmit`) is not a diagnostic
    if (line.startsWith("$ ")) continue;
    for (const f of FORMS) {
      const m = f.re.exec(line);
      if (!m) continue;
      const d = f.to(m, source);
      if (d) out.push(d);
      break;
    }
  }
  if (out.length > 0) return out;
  return stylish(lines, source);
}

/** Keeps the diagnostics of `files` (a file may be named by its end: `OrderTotal.kt`). */
export function diagnosticsIn(all: readonly Diagnostic[], files: readonly string[]): Diagnostic[] {
  if (files.length === 0) return [...all];
  const norm = files.map((f) => f.replace(/^\.\//, ""));
  return all.filter((d) => {
    const file = d.range?.file ?? "";
    return norm.some((f) => file === f || file.endsWith(`/${f}`) || f.endsWith(`/${file}`));
  });
}

/** `src/a.ts:12:5 error TS2322 Type …`, errors first, at most `max`. */
export function diagnosticsText(all: readonly Diagnostic[], max = 100): string {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...all].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.range?.file ?? "").localeCompare(b.range?.file ?? "") ||
      (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0),
  );
  const errors = all.filter((d) => d.severity === "error").length;
  const files = new Set(all.map((d) => d.range?.file)).size;
  const head = `${errors} error(s), ${all.length - errors} other in ${files} file(s)`;
  const lines = sorted
    .slice(0, max)
    .map(
      (d) =>
        `${d.range?.file ?? "?"}:${d.range?.startLine ?? "?"}${d.range?.startColumn ? `:${d.range.startColumn}` : ""} ${d.severity}${d.code ? ` ${d.code}` : ""} ${d.message} (${d.source})`,
    );
  return [head, ...lines, ...(sorted.length > max ? [`… ${sorted.length - max} more`] : [])].join("\n");
}
