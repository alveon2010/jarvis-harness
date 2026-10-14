import type { SpecifierResolver } from "../../core/capabilities/contracts.ts";

/**
 * Class names to files of the tree (ADR-0008 §1): `a.b.C` is the file `…/a/b/C.java` (or .groovy,
 * .kt) under any source root; of several (modules of one build), the one nearest the importing file.
 * A nested class `a.b.C.Inner` is its outer class's file. A class outside the tree is its package
 * (`pkg:org.example.web`); a candidate (`?a.b.C`, a type named in the code) outside the tree is no
 * edge at all.
 */
export const JAVA_RESOLVER_VERSION = 1;

const SOURCE = /\.(java|groovy|kt)$/;

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

export class JavaResolver implements SpecifierResolver {
  /** `a/b/C` (a path without the source root and extension) → files ending with it, by its last segment. */
  private readonly byName = new Map<string, string[]>();

  constructor(files: ReadonlySet<string>) {
    for (const f of files) {
      if (!SOURCE.test(f)) continue;
      const name = f.replace(/^.*\//, "").replace(SOURCE, "");
      this.byName.set(name, [...(this.byName.get(name) ?? []), f]);
    }
  }

  resolve(from: string, spec: string): string | null | undefined {
    const candidate = spec.startsWith("?");
    const name = candidate ? spec.slice(1) : spec;
    if (!/^[\w.]+$/.test(name)) return undefined;
    const parts = name.split(".");
    // the longest prefix that is a class of the tree: a.b.C.Inner → a.b.C
    for (let n = parts.length; n >= 1; n -= 1) {
      const last = parts[n - 1] as string;
      if (!/^[A-Z]/.test(last)) break;
      const file = this.fileOf(from, parts.slice(0, n));
      if (file) return file === from ? null : file;
    }
    if (candidate) return null;
    const pkg = parts.filter(
      (p, i) => !/^[A-Z]/.test(p) && parts.slice(0, i).every((q) => !/^[A-Z]/.test(q)),
    );
    return `pkg:${(pkg.length > 0 ? pkg : parts).join(".")}`;
  }

  private fileOf(from: string, parts: readonly string[]): string | undefined {
    const tail = `${parts.join("/")}`;
    const found = (this.byName.get(parts.at(-1) as string) ?? []).filter((f) => {
      const stem = f.replace(SOURCE, "");
      return stem === tail || stem.endsWith(`/${tail}`);
    });
    if (found.length <= 1) return found[0];
    return [...found].sort((a, b) => sharedPrefix(b, from) - sharedPrefix(a, from) || a.localeCompare(b))[0];
  }
}
