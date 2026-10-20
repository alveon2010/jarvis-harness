/**
 * The lines of a command's output that say what broke, the rest folded: what a person reads first and
 * what an agent gets when the runner wrote no report (pilot: the last lines of a Gradle build are its
 * summary, «BUILD FAILED in 41s», and the compiler's error was 300 lines above).
 */

const BROKE =
  /(\berror\b|exception|\bfail(ed|ure|s)?\b|assert|expected|\bcaused by\b|cannot find|unresolved|not found|\bpanic\b|traceback|✗|✘|✖)/i;
/** A runner's own success lines that look like failures: «0 failed», «failures: 0». */
const NOT_BROKE = /(\b0 (failed|failures|errors)\b|\bfail(ures|ed)?:\s*0\b|\berrors?:\s*0\b)/i;

/** The line says what broke. */
export const brokeLine = (line: string): boolean => BROKE.test(line) && !NOT_BROKE.test(line);

export interface Excerpt {
  /** Kept lines and folded runs, in order. */
  readonly parts: ReadonlyArray<
    | { readonly kind: "lines"; readonly from: number; readonly lines: readonly string[] }
    | { readonly kind: "fold"; readonly from: number; readonly count: number }
  >;
  /** Lines that say what broke. */
  readonly hits: number;
  readonly total: number;
}

/** The output with the lines around what broke kept and the rest folded; the end is always kept. */
export function excerptOf(
  text: string,
  opts: { around?: number; after?: number; tail?: number } = {},
): Excerpt {
  const around = opts.around ?? 2;
  const after = opts.after ?? 8;
  const tailN = opts.tail ?? 6;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const keep = new Array<boolean>(lines.length).fill(false);
  let hits = 0;
  lines.forEach((l, i) => {
    if (!brokeLine(l)) return;
    hits++;
    for (let j = Math.max(0, i - around); j <= Math.min(lines.length - 1, i + after); j++) keep[j] = true;
  });
  for (let j = Math.max(0, lines.length - tailN); j < lines.length; j++) keep[j] = true;
  const parts: Array<Excerpt["parts"][number]> = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const kept = keep[i];
    while (i < lines.length && keep[i] === kept) i++;
    // a fold of a line or two is not worth it
    if (!kept && i - start <= 2) {
      const last = parts.at(-1);
      const these = lines.slice(start, i);
      if (last?.kind === "lines") parts[parts.length - 1] = { ...last, lines: [...last.lines, ...these] };
      else parts.push({ kind: "lines", from: start, lines: these });
      continue;
    }
    if (kept) {
      const last = parts.at(-1);
      if (last?.kind === "lines")
        parts[parts.length - 1] = { ...last, lines: [...last.lines, ...lines.slice(start, i)] };
      else parts.push({ kind: "lines", from: start, lines: lines.slice(start, i) });
    } else parts.push({ kind: "fold", from: start, count: i - start });
  }
  return { parts, hits, total: lines.length };
}

/** The excerpt as text for an agent, cut to `maxChars`: folds as `… N lines …`. */
export function excerptText(text: string, maxChars = 2400): string {
  const ex = excerptOf(text);
  const out = ex.parts
    .map((p) => (p.kind === "fold" ? `… ${p.count} lines …` : p.lines.join("\n")))
    .join("\n");
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 40)}\n… (cut; the whole output is kept)`;
}
