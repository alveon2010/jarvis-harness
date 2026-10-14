import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * Java syntax through tree-sitter (WASM: no native build, no JVM, no network): the types, members
 * and calls of one file, with the receiver of each call typed where the file itself says it — a
 * field, a parameter, a local, `this`, a class name, `new X()`. Names stay as written; the tree-level
 * resolver (src/adapters/java/resolver.ts) turns them into classes of the tree with the file's
 * imports. Pilot (a Spring service, 525 Java files): every file parsed without an error, the whole
 * tree in under a second.
 */

export interface JavaMethod {
  /** `find/1`: name and arity — overloads of one arity are one node. */
  readonly key: string;
  readonly name: string;
  readonly params: readonly string[];
  readonly returns?: string;
  readonly annotations: readonly string[];
  readonly isStatic: boolean;
  readonly line: number;
  readonly endLine: number;
  /** Calls made in the body: the receiver's type as written (`OrderRepository`, `Outer.Inner`) and the callee. */
  readonly calls: ReadonlyArray<{ readonly type: string; readonly method: string; readonly arity: number }>;
}

export interface JavaType {
  /** `Outer` or `Outer.Inner`. */
  readonly path: string;
  readonly kind: "class" | "interface" | "enum" | "record" | "annotation";
  readonly isAbstract: boolean;
  readonly isPublic: boolean;
  readonly annotations: readonly string[];
  readonly extends: readonly string[];
  readonly implements: readonly string[];
  /** Field name → its type as written. */
  readonly fields: Readonly<Record<string, string>>;
  readonly methods: readonly JavaMethod[];
  readonly line: number;
  readonly endLine: number;
}

export interface JavaFile {
  readonly pkg: string;
  readonly imports: readonly string[];
  readonly wildcards: readonly string[];
  readonly staticImports: readonly string[];
  readonly types: readonly JavaType[];
  readonly errors: boolean;
}

let ready: Promise<Parser> | undefined;

/** One parser for the process: the WASM runtime and the grammar load once. */
function parser(): Promise<Parser> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const java = await Language.load(require.resolve("tree-sitter-java/tree-sitter-java.wasm"));
    const p = new Parser();
    p.setLanguage(java);
    return p;
  })();
  return ready;
}

const kids = (n: Node | null | undefined): Node[] =>
  n ? n.namedChildren.filter((c): c is Node => c !== null) : [];

/** A type as written, without type arguments, arrays and annotations: `List<Order>` → `List`. */
export function baseType(text: string): string {
  return text
    .replace(/@[\w.]+(\([^)]*\))?\s*/g, "")
    .replace(/<.*>/s, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\.\.\.$/, "")
    .trim();
}

function annotationsOf(node: Node): string[] {
  const mods = kids(node).find((c) => c.type === "modifiers");
  return kids(mods)
    .filter((c) => c.type === "marker_annotation" || c.type === "annotation")
    .map((c) => (c.childForFieldName("name")?.text ?? "").replace(/^.*\./, ""))
    .filter(Boolean);
}

function modifiersOf(node: Node): string {
  return kids(node).find((c) => c.type === "modifiers")?.text ?? "";
}

const TYPE_KINDS: Record<string, JavaType["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

/** The declared types a parameter list or a declaration names: name → type. */
function paramsOf(list: Node | null): Array<[string, string]> {
  return kids(list)
    .filter((p) => p.type === "formal_parameter" || p.type === "spread_parameter")
    .map((p) => {
      const type =
        p.childForFieldName("type") ??
        kids(p).find((c) => c.type.endsWith("type") || c.type === "type_identifier");
      const name =
        p.childForFieldName("name") ??
        kids(p)
          .find((c) => c.type === "variable_declarator")
          ?.childForFieldName("name");
      return [name?.text ?? "", baseType(type?.text ?? "")] as [string, string];
    })
    .filter(([n, t]) => n && t);
}

/** Locals of a body: declared types, and `var x = new X(…)` as X. */
function localsOf(body: Node | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  const add = (name: string | undefined, type: string | undefined) => {
    if (name && type && type !== "var") out.set(name, type);
  };
  for (const d of body.descendantsOfType([
    "local_variable_declaration",
    "enhanced_for_statement",
    "catch_formal_parameter",
    "resource",
  ])) {
    if (!d) continue;
    const type = baseType(
      d.childForFieldName("type")?.text ??
        kids(d)
          .find((c) => c.type === "catch_type")
          ?.text.split("|")[0] ??
        "",
    );
    if (d.type === "local_variable_declaration") {
      for (const v of kids(d).filter((c) => c.type === "variable_declarator")) {
        const value = v.childForFieldName("value");
        add(
          v.childForFieldName("name")?.text,
          type === "var" && value?.type === "object_creation_expression"
            ? baseType(value.childForFieldName("type")?.text ?? "")
            : type,
        );
      }
    } else add(d.childForFieldName("name")?.text, type);
  }
  return out;
}

function callsOf(
  body: Node | null,
  scope: { self: string; superclass?: string; fields: Map<string, string>; locals: Map<string, string> },
): JavaMethod["calls"] {
  if (!body) return [];
  const out = new Map<string, { type: string; method: string; arity: number }>();
  const typeOf = (o: Node | null): string | undefined => {
    if (!o) return scope.self;
    if (o.type === "this") return scope.self;
    if (o.type === "super") return scope.superclass;
    if (o.type === "identifier") {
      const v = scope.locals.get(o.text) ?? scope.fields.get(o.text);
      if (v) return v;
      return /^[A-Z]\w*[a-z]/.test(o.text) ? o.text : undefined; // a class (not a CONSTANT): a static call
    }
    if (o.type === "field_access") {
      const obj = o.childForFieldName("object");
      const field = o.childForFieldName("field")?.text ?? "";
      if (obj?.type === "this") return scope.fields.get(field);
      // `a.b.C` written in place: a qualified class
      return /^[a-z_][\w]*(\.[a-z_]\w*)*\.[A-Z]\w*$/.test(o.text) ? o.text : undefined;
    }
    if (o.type === "object_creation_expression")
      return baseType(o.childForFieldName("type")?.text ?? "") || undefined;
    if (o.type === "parenthesized_expression") return typeOf(kids(o)[0] ?? null);
    return undefined;
  };
  const add = (type: string | undefined, method: string, arity: number) => {
    if (!type) return;
    out.set(`${type}#${method}/${arity}`, { type, method, arity });
  };
  for (const c of body.descendantsOfType([
    "method_invocation",
    "object_creation_expression",
    "method_reference",
  ])) {
    if (!c) continue;
    if (c.type === "method_invocation") {
      const name = c.childForFieldName("name")?.text;
      if (name)
        add(typeOf(c.childForFieldName("object")), name, kids(c.childForFieldName("arguments")).length);
    } else if (c.type === "object_creation_expression") {
      const type = baseType(c.childForFieldName("type")?.text ?? "");
      if (type && !c.childForFieldName("class_body"))
        add(type, "<init>", kids(c.childForFieldName("arguments")).length);
    } else {
      // `OrderMapper::toDto`, `this::check`, `repo::save`: arity unknown, the name decides
      const [target, name] = [kids(c)[0] ?? null, kids(c).at(-1)?.text];
      if (name && name !== "new") add(typeOf(target), name, -1);
    }
  }
  return [...out.values()].sort((a, b) =>
    `${a.type}#${a.method}/${a.arity}`.localeCompare(`${b.type}#${b.method}/${b.arity}`),
  );
}

function typesOf(root: Node): JavaType[] {
  const out: JavaType[] = [];
  const visit = (node: Node, outer: string | undefined, outerFields: Map<string, string>) => {
    const kind = TYPE_KINDS[node.type];
    if (!kind) return;
    const name = node.childForFieldName("name")?.text ?? "";
    const path = outer ? `${outer}.${name}` : name;
    const types = (n: Node | null | undefined) =>
      kids(n?.type === "type_list" ? n : kids(n).find((c) => c.type === "type_list")).map((t) =>
        baseType(t.text),
      );
    const superclass = node.childForFieldName("superclass");
    const ext =
      kind === "interface"
        ? types(kids(node).find((c) => c.type === "extends_interfaces"))
        : superclass
          ? [baseType(kids(superclass)[0]?.text ?? "")]
          : [];
    const impl =
      kind === "interface"
        ? []
        : types(
            node.childForFieldName("interfaces") ?? kids(node).find((c) => c.type === "super_interfaces"),
          );
    const body = node.childForFieldName("body");
    const members = kids(body).flatMap((m) => (m.type === "enum_body_declarations" ? kids(m) : [m]));
    const fields = new Map(outerFields);
    for (const [n, t] of paramsOf(node.childForFieldName("parameters"))) fields.set(n, t); // record components
    for (const f of members.filter(
      (m) => m.type === "field_declaration" || m.type === "constant_declaration",
    )) {
      const t = baseType(f.childForFieldName("type")?.text ?? "");
      for (const v of kids(f).filter((c) => c.type === "variable_declarator")) {
        const n = v.childForFieldName("name")?.text;
        if (n && t) fields.set(n, t);
      }
    }
    const methods: JavaMethod[] = [];
    for (const m of members.filter(
      (x) =>
        x.type === "method_declaration" ||
        x.type === "constructor_declaration" ||
        x.type === "compact_constructor_declaration",
    )) {
      const params = paramsOf(m.childForFieldName("parameters"));
      const mname = m.type === "method_declaration" ? (m.childForFieldName("name")?.text ?? "") : "<init>";
      const mbody = m.childForFieldName("body");
      const locals = localsOf(mbody);
      for (const [n, t] of params) locals.set(n, t);
      const returns =
        m.type === "method_declaration" ? baseType(m.childForFieldName("type")?.text ?? "") : undefined;
      methods.push({
        key: `${mname}/${params.length}`,
        name: mname,
        params: params.map(([, t]) => t),
        ...(returns ? { returns } : {}),
        annotations: annotationsOf(m),
        isStatic: /\bstatic\b/.test(modifiersOf(m)),
        line: m.startPosition.row + 1,
        endLine: m.endPosition.row + 1,
        calls: callsOf(mbody, {
          self: path,
          ...(ext[0] && kind !== "interface" ? { superclass: ext[0] } : {}),
          fields,
          locals,
        }),
      });
    }
    const mods = modifiersOf(node);
    out.push({
      path,
      kind,
      isAbstract: kind === "interface" || /\babstract\b/.test(mods),
      isPublic: /\bpublic\b/.test(mods),
      annotations: annotationsOf(node),
      extends: ext.filter(Boolean),
      implements: impl.filter(Boolean),
      fields: Object.fromEntries(
        [...fields].filter(([n]) => !outerFields.has(n) || fields.get(n) !== outerFields.get(n)),
      ),
      methods,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
    for (const m of members) visit(m, path, fields);
  };
  for (const n of kids(root)) visit(n, undefined, new Map());
  return out;
}

export async function parseJava(content: string): Promise<JavaFile> {
  const p = await parser();
  const tree = p.parse(content);
  if (!tree) return { pkg: "", imports: [], wildcards: [], staticImports: [], types: [], errors: true };
  try {
    const root = tree.rootNode;
    const pkg =
      kids(kids(root).find((c) => c.type === "package_declaration")).find(
        (c) => c.type !== "annotation" && c.type !== "marker_annotation",
      )?.text ?? "";
    const imports: string[] = [];
    const wildcards: string[] = [];
    const staticImports: string[] = [];
    for (const imp of kids(root).filter((c) => c.type === "import_declaration")) {
      const m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(imp.text.replace(/\s+/g, " "));
      if (!m) continue;
      const name = m[2] as string;
      if (m[1]) staticImports.push(m[3] ? `${name}.*` : name);
      else if (m[3]) wildcards.push(name);
      else imports.push(name);
    }
    return { pkg, imports, wildcards, staticImports, types: typesOf(root), errors: root.hasError };
  } finally {
    tree.delete();
  }
}
