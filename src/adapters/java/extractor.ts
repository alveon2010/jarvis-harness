import type {
  FileFacts,
  GraphEdge,
  GraphNode,
  ProjectGraphExtractor,
  SpecifierResolver,
} from "../../core/capabilities/contracts.ts";
import { JAVA_RESOLVER_VERSION, JavaResolver } from "./resolver.ts";
import { parseJvmSource } from "./source.ts";

/**
 * Java / Groovy / Kotlin facts (ADR-0008 §1, ADR-0021 §6): a pure function of one file's content,
 * no compiler. A file depends on what it imports and on the types of its own package and of its
 * wildcard imports it names — the latter are candidates (`spec:?a.b.Name`) the resolver keeps only
 * when the tree has that class. A runnable test (under a test source set, named *Test, *Tests,
 * *Spec, *Specification or *IT, not abstract) is TESTED_BY what it uses; a base test class or a
 * fixture depends on what it uses, so the tests that extend or use it are found through it.
 */
export const JAVA_EXTRACTOR_VERSION = 1;

const TEST_SOURCES = /(^|\/)src\/(test|it|integrationTest|testFixtures|[a-z]+Test)\//;
const RUNNABLE = /(Test|Tests|Spec|Specification|IT)\.(java|groovy|kt)$/;

export function isTestSource(file: string): boolean {
  return TEST_SOURCES.test(file);
}

function sorted<T extends { id?: string; from?: string; to?: string; relation?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    `${a.id ?? ""}${a.from ?? ""}${a.relation ?? ""}${a.to ?? ""}`.localeCompare(
      `${b.id ?? ""}${b.from ?? ""}${b.relation ?? ""}${b.to ?? ""}`,
    ),
  );
}

export class JavaExtractor implements ProjectGraphExtractor {
  readonly version = JAVA_EXTRACTOR_VERSION;
  readonly extensions = [".java", ".groovy", ".kt"];
  readonly resolverVersion = JAVA_RESOLVER_VERSION;

  createResolver(_workspace: string, files: ReadonlySet<string>): SpecifierResolver {
    return new JavaResolver(files);
  }

  async extract(file: string, content: string): Promise<FileFacts> {
    const src = parseJvmSource(content);
    const own = file.replace(/^.*\//, "").replace(/\.\w+$/, "");
    const main = src.types.find((t) => t.name === own) ?? src.types[0];
    const isTest =
      isTestSource(file) && RUNNABLE.test(file) && !main?.abstract && !own.startsWith("Abstract");
    const nodes: GraphNode[] = [
      {
        id: file,
        kind: isTest ? "Test" : "Module",
        file,
        metadata: { lines: src.lines, ...(src.pkg ? { package: src.pkg } : {}) },
      },
      ...src.types.map(
        (t): GraphNode => ({
          id: `${file}#${t.name}`,
          kind: "Type",
          file,
          metadata: { exported: t.exported, line: t.line },
        }),
      ),
    ];
    const specs = new Set<string>();
    for (const i of src.imports) {
      // `import static a.b.C.member` and `import static a.b.C.*` both depend on the class a.b.C
      if (i.isStatic) specs.add(i.wildcard ? i.name : i.name.replace(/\.[^.]+$/, ""));
      else if (!i.wildcard) specs.add(i.name);
    }
    const scopes = [src.pkg, ...src.imports.filter((i) => i.wildcard && !i.isStatic).map((i) => i.name)];
    for (const name of src.used) for (const scope of scopes) specs.add(`?${scope ? `${scope}.` : ""}${name}`);
    const relation: GraphEdge["relation"] = isTest ? "TESTED_BY" : "DEPENDS_ON";
    const edges: GraphEdge[] = [...specs].map((spec) => ({ from: file, to: `spec:${spec}`, relation }));
    return { nodes: sorted(nodes), edges: sorted(edges) };
  }
}
