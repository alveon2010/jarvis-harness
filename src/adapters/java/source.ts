/**
 * The parts of a JVM source file (Java, Groovy, Kotlin) a dependency graph needs, without a parser:
 * the package, the imports, the types it declares and the type names it uses. Comments and string
 * literals are blanked first (newlines kept, so lines still count), so a name in a log message or a
 * commented-out line is no reference.
 */
export interface JvmSource {
  readonly pkg: string;
  readonly imports: ReadonlyArray<{
    readonly name: string;
    readonly isStatic: boolean;
    readonly wildcard: boolean;
  }>;
  /** Types declared in the file: name, line, public or not, abstract or not. */
  readonly types: ReadonlyArray<{
    readonly name: string;
    readonly line: number;
    readonly exported: boolean;
    readonly abstract: boolean;
  }>;
  /** Capitalised names used in the code, minus the imported and the declared ones. */
  readonly used: readonly string[];
  readonly lines: number;
}

/** Comments and (unless `keepStrings`) string and char literals as spaces; newlines stay. */
export function blankLiterals(src: string, keepStrings = false): string {
  const out: string[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    let end = -1;
    if (two === "//") {
      end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
    } else if (two === "/*") {
      end = src.indexOf("*/", i + 2);
      end = end < 0 ? src.length : end + 2;
    } else if (three === '"""' || three === "'''") {
      end = src.indexOf(three, i + 3);
      end = end < 0 ? src.length : end + 3;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      end = Math.min(j + 1, src.length);
    }
    if (end < 0) {
      out.push(c);
      i += 1;
    } else {
      const comment = two === "//" || two === "/*";
      out.push(comment || !keepStrings ? blank(src.slice(i, end)) : src.slice(i, end));
      i = end;
    }
  }
  return out.join("");
}

const PACKAGE = /^\s*package\s+([\w.]+)/m;
const IMPORT = /^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/gm;
const TYPE_DECL =
  /^([ \t]*)((?:(?:public|protected|private|abstract|static|final|sealed|non-sealed|open|data|internal|inner)\s+)*)(class|interface|enum|record|@interface|trait|object)\s+([A-Z]\w*)/gm;
const NAME = /\b[A-Z][A-Za-z0-9_]*\b/g;

export function parseJvmSource(content: string): JvmSource {
  const code = blankLiterals(content);
  const pkg = PACKAGE.exec(code)?.[1] ?? "";
  const imports: Array<{ name: string; isStatic: boolean; wildcard: boolean }> = [];
  for (const m of code.matchAll(IMPORT))
    imports.push({ name: m[2] as string, isStatic: Boolean(m[1]), wildcard: Boolean(m[3]) });
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const types: Array<{ name: string; line: number; exported: boolean; abstract: boolean }> = [];
  for (const m of code.matchAll(TYPE_DECL)) {
    const mods = m[2] ?? "";
    types.push({
      name: m[4] as string,
      line: lineAt(m.index ?? 0),
      // Groovy and Kotlin types are public unless they say otherwise; Java's need the word
      exported: /\bpublic\b/.test(mods) || !/\b(private|protected|internal)\b/.test(mods),
      abstract: /\babstract\b/.test(mods) || m[3] === "interface",
    });
  }
  const known = new Set<string>([
    ...types.map((t) => t.name),
    ...imports.filter((i) => !i.wildcard).map((i) => i.name.split(".").at(-1) as string),
  ]);
  // the body only: the names in package and import lines are not uses
  const body = code.replace(/^\s*(package|import)\s.*$/gm, "");
  const used = new Set<string>();
  // CONSTANT_NAMES are fields, not types
  for (const m of body.matchAll(NAME))
    if (!known.has(m[0]) && !/^[A-Z0-9]+_[A-Z0-9_]*$/.test(m[0])) used.add(m[0]);
  return { pkg, imports, types, used: [...used].sort(), lines: content.split("\n").length };
}
