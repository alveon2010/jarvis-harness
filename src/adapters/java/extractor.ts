import type {
  FileFacts,
  GraphEdge,
  GraphNode,
  ProjectGraphExtractor,
  SpecifierResolver,
} from "../../core/capabilities/contracts.ts";
import { type JavaFile, parseJava } from "./ast.ts";
import { JAVA_RESOLVER_VERSION, JavaResolver } from "./resolver.ts";
import { parseJvmSource } from "./source.ts";
import { SPRING_CONFIG, springFacts, topicFacts } from "./spring.ts";

/**
 * Java / Groovy / Kotlin facts (ADR-0008 §1, ADR-0021 §6): a pure function of one file's content,
 * no compiler. A file depends on what it imports and on the types of its own package and of its
 * wildcard imports it names — the latter are candidates (`spec:?a.b.Name`) the resolver keeps only
 * when the tree has that class. A runnable test (under a test source set, named *Test, *Tests,
 * *Spec, *Specification or *IT, not abstract) is TESTED_BY what it uses; a base test class or a
 * fixture depends on what it uses, so the tests that extend or use it are found through it.
 * Spring endpoints, Feign client calls, Kafka listeners and the topics of `application*.yml` are
 * `Endpoint` and `Event` nodes (src/adapters/java/spring.ts). A Java file is parsed (tree-sitter,
 * src/adapters/java/ast.ts): its types and methods are nodes (`file#Outer.Inner`,
 * `file#Type.method/arity`), with EXTENDS / IMPLEMENTS of their supertypes and CALLS of the methods
 * their bodies call, named as written (`spec:type:…`, `spec:call:Type#method/arity`) for the resolver.
 * Groovy and Kotlin keep the lexical reading. A test file's path literals (`"/api/orders/$id"`) are
 * `spec:url:` — the resolver links the test to the controller that serves the path: a MockMvc test
 * names no controller class, only its URL.
 */
export const JAVA_EXTRACTOR_VERSION = 5;

/** Path literals of a test: `"/api/orders/$id"`, `'/slots/${zone}'` → `/api/orders/{p}`, once each. */
export function urlsIn(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/["'](\/[^"'\s?#]*)/g)) {
    const path = (m[1] as string)
      .replace(/\$\{[^}]*\}/g, "{p}")
      .replace(/\$[A-Za-z_]\w*/g, "{p}")
      .replace(/\/+$/, "");
    if (/[A-Za-z]/.test(path) && !/\.(json|xml|csv|txt|pdf|yml|yaml|sql|html?)$/i.test(path)) out.add(path);
  }
  return [...out].sort();
}

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
  readonly extensions = [".java", ".groovy", ".kt", ".yml", ".yaml"];
  readonly resolverVersion = JAVA_RESOLVER_VERSION;

  createResolver(
    _workspace: string,
    files: ReadonlySet<string>,
    nodes?: readonly GraphNode[],
  ): SpecifierResolver {
    return new JavaResolver(files, nodes);
  }

  async extract(file: string, content: string): Promise<FileFacts> {
    if (/\.ya?ml$/.test(file)) {
      // only a Spring config: its topics; any other YAML is no part of the graph
      if (!SPRING_CONFIG.test(file)) return { nodes: [], edges: [] };
      const lines = content.split("\n").length;
      return {
        nodes: sorted([
          { id: file, kind: "Module", file, metadata: { lines } },
          ...topicFacts(file, content),
        ]),
        edges: [],
      };
    }
    const src = parseJvmSource(content);
    const java = file.endsWith(".java") ? await parseJava(content) : undefined;
    const own = file.replace(/^.*\//, "").replace(/\.\w+$/, "");
    const main = src.types.find((t) => t.name === own) ?? src.types[0];
    const abstract = java
      ? (java.types.find((t) => t.path === own) ?? java.types[0])?.isAbstract
      : main?.abstract;
    const isTest = isTestSource(file) && RUNNABLE.test(file) && !abstract && !own.startsWith("Abstract");
    const spring = isTestSource(file) ? { nodes: [] } : springFacts(file, content);
    const nodes: GraphNode[] = [
      {
        id: file,
        kind: isTest ? "Test" : "Module",
        file,
        metadata: {
          lines: src.lines,
          ...(src.pkg ? { package: src.pkg } : {}),
          ...(java
            ? { imports: java.imports, wildcards: java.wildcards, staticImports: java.staticImports }
            : {}),
          ...("route" in spring ? { route: spring.route, extends: spring.base } : {}),
        },
      },
      ...(java
        ? symbolNodes(file, java)
        : src.types.map(
            (t): GraphNode => ({
              id: `${file}#${t.name}`,
              kind: "Type",
              file,
              metadata: { exported: t.exported, line: t.line },
            }),
          )),
      ...spring.nodes,
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
    // a test reaches a controller through its URL
    if (isTestSource(file)) for (const url of urlsIn(content)) specs.add(`url:${url}`);
    const edges: GraphEdge[] = [
      ...[...specs].map((spec) => ({ from: file, to: `spec:${spec}`, relation })),
      ...(java ? symbolEdges(file, java) : []),
    ];
    return { nodes: sorted(nodes), edges: sorted(edges) };
  }
}

/** Types and methods of a parsed Java file as nodes. */
function symbolNodes(file: string, java: JavaFile): GraphNode[] {
  const fqn = (path: string) => (java.pkg ? `${java.pkg}.${path}` : path);
  return java.types.flatMap((t): GraphNode[] => [
    {
      id: `${file}#${t.path}`,
      kind: "Type",
      file,
      metadata: {
        fqn: fqn(t.path),
        type: t.kind,
        exported: t.isPublic,
        ...(t.isAbstract ? { abstract: true } : {}),
        ...(t.annotations.length > 0 ? { annotations: t.annotations } : {}),
        ...(t.extends.length > 0 ? { extends: t.extends } : {}),
        ...(t.implements.length > 0 ? { implements: t.implements } : {}),
        ...(Object.keys(t.fields).length > 0 ? { fields: t.fields } : {}),
        line: t.line,
        endLine: t.endLine,
      },
    },
    ...t.methods.map(
      (m): GraphNode => ({
        id: `${file}#${t.path}.${m.key}`,
        kind: "Function",
        file,
        metadata: {
          params: m.params,
          ...(m.returns ? { returns: m.returns } : {}),
          ...(m.annotations.length > 0 ? { annotations: m.annotations } : {}),
          ...(m.isStatic ? { static: true } : {}),
          line: m.line,
          endLine: m.endLine,
        },
      }),
    ),
  ]);
}

/** Supertypes and calls as written, for the resolver: `spec:type:Name`, `spec:call:Type#method/arity`. */
function symbolEdges(file: string, java: JavaFile): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const t of java.types) {
    const from = `${file}#${t.path}`;
    for (const s of t.extends) edges.push({ from, to: `spec:type:${s}`, relation: "EXTENDS" });
    for (const s of t.implements) edges.push({ from, to: `spec:type:${s}`, relation: "IMPLEMENTS" });
    for (const m of t.methods)
      for (const c of m.calls)
        edges.push({
          from: `${from}.${m.key}`,
          to: `spec:call:${c.type}#${c.method}/${c.arity}`,
          relation: "CALLS",
        });
  }
  return edges;
}
