import type { GraphNode, ProjectGraphExtractor } from "../../core/capabilities/contracts.ts";

/**
 * A long file as its outline, and one symbol of it as its lines — from the facts of the stack's
 * extractor, read from the file as it is now (an extractor that records line ranges: Java). A weak
 * model reading a 1,500-line service whole spends its context on methods it never needed; with the
 * outline it reads the two it does.
 */
export const OUTLINE_ABOVE_LINES = 400;

export interface OutlineSymbol {
  /** `Type`, `Outer.Inner`, `Type.method/1`. */
  readonly name: string;
  readonly kind: "type" | "method";
  readonly line: number;
  readonly endLine: number;
  readonly label: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The symbols with a line range among a file's facts, in file order. */
export function outlineSymbols(file: string, nodes: readonly GraphNode[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  for (const n of nodes) {
    if (n.file !== file || !n.id.startsWith(`${file}#`)) continue;
    const m = n.metadata ?? {};
    if (typeof m.line !== "number" || typeof m.endLine !== "number") continue;
    const name = n.id.slice(file.length + 1);
    const ann = strs(m.annotations).map((a) => `@${a}`);
    if (n.kind === "Type") {
      const supers = [
        ...strs(m.extends).map((s) => `extends ${s}`),
        ...strs(m.implements).map((s) => `implements ${s}`),
      ];
      const fields = Object.entries((m.fields ?? {}) as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .slice(0, 12);
      out.push({
        name,
        kind: "type",
        line: m.line,
        endLine: m.endLine,
        label: [
          `${[...ann, str(m.type) ?? "type", name].join(" ")}${supers.length > 0 ? ` ${supers.join(", ")}` : ""}`,
          ...(fields.length > 0 ? [`  fields: ${fields.join(", ")}`] : []),
        ].join("\n"),
      });
    } else if (n.kind === "Function") {
      const method = name.replace(/\/-?\d+$/, "").replace(/^.*\./, "");
      const returns = str(m.returns);
      out.push({
        name,
        kind: "method",
        line: m.line,
        endLine: m.endLine,
        label: `${[...ann, ""].join(" ")}${method}(${strs(m.params).join(", ")})${returns ? `: ${returns}` : ""}`,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** The facts of a file as it is now, from the extractor that takes it; none for a stack without one. */
export async function currentSymbols(
  extractors: readonly ProjectGraphExtractor[],
  file: string,
  content: string,
): Promise<OutlineSymbol[]> {
  const x = extractors.find((e) => e.extensions.some((ext) => file.endsWith(ext)));
  if (!x) return [];
  try {
    return outlineSymbols(file, (await x.extract(file, content)).nodes);
  } catch {
    return [];
  }
}

/** The outline text: each type and method with its lines, indented under its type. */
export function outlineText(file: string, lines: number, symbols: readonly OutlineSymbol[]): string {
  const rows = symbols.map((s) => {
    const depth = s.kind === "method" ? s.name.split(".").length - 1 : s.name.split(".").length - 1;
    const pad = "  ".repeat(depth);
    const [first, ...rest] = s.label.split("\n");
    return [`${pad}${first}  [${s.line}-${s.endLine}]`, ...rest.map((r) => `${pad}${r}`)].join("\n");
  });
  return [
    `${file}: ${lines} lines — its outline (read whole only if you need all of it):`,
    ...rows,
    `Read a part: repo.read with symbol (e.g. "${symbols.find((s) => s.kind === "method")?.name.replace(/\/-?\d+$/, "") ?? symbols[0]?.name ?? "Type.method"}") or startLine/endLine; full: true for the whole file.`,
  ].join("\n");
}

/** A symbol by name — `Type.method`, `Type.method/2`, `method`, `Type` — of the outline. */
export function findSymbol(symbols: readonly OutlineSymbol[], name: string): OutlineSymbol[] {
  const q = name.trim().replace(/\(.*\)$/, "");
  const bare = (s: OutlineSymbol) => s.name.replace(/\/-?\d+$/, "");
  const exact = symbols.filter((s) => s.name === q || bare(s) === q);
  if (exact.length > 0) return exact;
  return symbols.filter((s) => bare(s).endsWith(`.${q}`));
}
