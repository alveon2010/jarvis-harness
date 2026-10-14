import type { GraphNode } from "../core/capabilities/contracts.ts";
import type { ContractEntry } from "./contracts.ts";

/**
 * The contracts a repository's own code states, from the project graph: its HTTP endpoints (`Endpoint`
 * nodes — served here, or called through a client of another service) and its message topics (`Event`
 * nodes: a topic its config names, a listener of one). The sources step checks a task's `METHOD /path`
 * and topic names against them as it does against a contract map.
 */
export interface TopicEntry {
  readonly topic: string;
  readonly property: string;
  readonly file: string;
  readonly line?: number;
}

export interface ListenerEntry {
  /** The topic as the code names it: a literal, or the config property it reads. */
  readonly topic?: string;
  readonly property?: string;
  readonly handler?: string;
  readonly file: string;
  readonly line?: number;
}

export interface CodeContracts {
  readonly endpoints: readonly ContractEntry[];
  readonly topics: readonly TopicEntry[];
  readonly listeners: readonly ListenerEntry[];
  /** Classes that send messages, with the topics of the config they name. */
  readonly senders?: ReadonlyArray<{
    readonly type: string;
    readonly file: string;
    readonly line?: number;
    readonly topics: readonly TopicEntry[];
  }>;
  /** Config bindings: a prefix (`@ConfigurationProperties`) or a property (`@Value`) and the class reading it. */
  readonly config?: ReadonlyArray<{
    readonly key: string;
    readonly prefix: boolean;
    readonly type: string;
    readonly file: string;
    readonly line?: number;
  }>;
  /** Stored data: a collection and its document class, a repository and its entity. */
  readonly data?: ReadonlyArray<{
    readonly kind: "collection" | "repository";
    readonly name: string;
    readonly of: string;
    readonly file: string;
  }>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** `{ name: value }` when the value is a non-empty string, else nothing. */
const opt = <K extends string>(name: K, v: unknown): { [P in K]?: string } =>
  (typeof v === "string" && v ? { [name]: v } : {}) as { [P in K]?: string };
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const typeOf = (file: string) => file.replace(/^.*\//, "").replace(/\.\w+$/, "");
const joinPath = (a: string, b: string) =>
  `/${[a, b]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")}`;

export function codeContractsOf(nodes: readonly GraphNode[]): CodeContracts {
  const endpoints: ContractEntry[] = [];
  // an API interface a controller implements is served, not called (generated from an OpenAPI spec)
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const servedApis = new Set(
    nodes
      .filter((n) => n.kind === "Type")
      .filter((n) => list(n.metadata?.annotations).some((a) => a === "RestController" || a === "Controller"))
      .flatMap((n) => list(n.metadata?.implements))
      .map((x) => x.replace(/^.*\./, "")),
  );
  // a module with a route of its own that extends a class with endpoints serves them under its route
  const subclasses = new Map<string, Array<{ file: string; route: string }>>();
  for (const n of nodes) {
    const route = str(n.metadata?.route) ?? (n.metadata?.route === "/" ? "/" : undefined);
    const base = str(n.metadata?.extends);
    if (n.kind === "Module" && route !== undefined && base && n.file)
      subclasses.set(base, [...(subclasses.get(base) ?? []), { file: n.file, route }]);
  }
  for (const n of nodes) {
    if (n.kind !== "Endpoint" || !n.file) continue;
    const m = n.metadata ?? {};
    const path = str(m.path) ?? "/";
    const entry = (file: string, p: string, handler: string | undefined, line?: number): ContractEntry => ({
      file,
      ...(handler ? { key: handler } : {}),
      ...opt("method", m.method),
      path: p,
      ...(line !== undefined ? { line } : {}),
      ...(m.direction === "out" &&
      (str(m.client) || !servedApis.has(String(m.handler ?? "").split(".")[0] ?? ""))
        ? { direction: "out" as const }
        : { direction: "in" as const }),
      ...opt("client", m.client),
    });
    const handler = str(m.handler);
    if (m.inherited !== true) {
      endpoints.push(entry(n.file, path, handler, num(m.line)));
      continue;
    }
    const owner = handler?.split(".")[0] ?? typeOf(n.file);
    for (const sub of subclasses.get(owner) ?? [])
      endpoints.push(
        entry(
          sub.file,
          joinPath(sub.route, path),
          handler ? `${typeOf(sub.file)}.${handler.split(".").slice(1).join(".")}` : undefined,
        ),
      );
  }
  const topics: TopicEntry[] = [];
  const listeners: ListenerEntry[] = [];
  for (const n of nodes) {
    if (n.kind !== "Event" || !n.file) continue;
    const m = n.metadata ?? {};
    const line = num(m.line);
    if (m.role === "topic" && str(m.topic) && str(m.property))
      topics.push({
        topic: str(m.topic) as string,
        property: str(m.property) as string,
        file: n.file,
        ...(line ? { line } : {}),
      });
    if (m.role === "listens")
      listeners.push({
        file: n.file,
        ...opt("topic", m.topic),
        ...opt("property", m.property),
        ...opt("handler", m.handler),
        ...(line ? { line } : {}),
      });
  }
  // senders: the topics whose property they read (@Value) or whose property has a key they name
  const senders: Array<NonNullable<CodeContracts["senders"]>[number]> = [];
  const config: Array<NonNullable<CodeContracts["config"]>[number]> = [];
  const data: Array<NonNullable<CodeContracts["data"]>[number]> = [];
  for (const n of nodes) {
    const m = n.metadata ?? {};
    if (!n.file) continue;
    const type = str(m.type) ?? typeOf(n.file);
    const line = num(m.line);
    if (n.kind === "Event" && m.role === "sends") {
      const props = new Set(list(m.properties));
      const keys = new Set(list(m.keys));
      const sent = topics.filter(
        (t) => props.has(t.property) || t.property.split(".").some((seg) => keys.has(seg)),
      );
      senders.push({ type, file: n.file, ...(line ? { line } : {}), topics: sent });
    } else if (n.kind === "Symbol" && m.role === "config") {
      const key = str(m.prefix) ?? str(m.property);
      if (key)
        config.push({
          key,
          prefix: str(m.prefix) !== undefined,
          type,
          file: n.file,
          ...(line ? { line } : {}),
        });
    } else if (n.kind === "DataModel" && m.role === "collection" && str(m.collection))
      data.push({ kind: "collection", name: str(m.collection) as string, of: type, file: n.file });
    else if (n.kind === "DataModel" && m.role === "repository" && str(m.repository))
      data.push({
        kind: "repository",
        name: str(m.repository) as string,
        of: str(m.entity) ?? "",
        file: n.file,
      });
  }
  return {
    endpoints,
    topics,
    listeners,
    ...(senders.length > 0 ? { senders } : {}),
    ...(config.length > 0
      ? { config: config.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file)) }
      : {}),
    ...(data.length > 0 ? { data } : {}),
  };
}

export interface TopicHit {
  readonly name: string;
  readonly from: string;
  readonly topics: readonly TopicEntry[];
  readonly listeners: readonly ListenerEntry[];
  /** Classes that send to it. */
  readonly senders?: readonly string[];
}

/** Config keys the sources name (`inaction.client-idle-delay`) with the classes that read them. */
export interface ConfigHit {
  readonly key: string;
  readonly from: string;
  readonly readers: ReadonlyArray<{
    readonly type: string;
    readonly file: string;
    readonly line?: number;
    readonly via: string;
  }>;
}

/** Dotted keys in the sources bound in the code: a `@Value` property, or under a `@ConfigurationProperties` prefix. */
export function configNamedIn(
  sources: ReadonlyArray<{ from: string; text: string }>,
  code: CodeContracts,
): ConfigHit[] {
  const bindings = code.config ?? [];
  if (bindings.length === 0) return [];
  const hits = new Map<string, ConfigHit>();
  for (const s of sources)
    for (const m of s.text.matchAll(/(?<![\w.$-])([a-z][\w-]*(?:\.[\w-]+)+)(?![\w-]|\.[\w])/g)) {
      const key = m[1] as string;
      if (
        hits.has(key) ||
        /\.(java|groovy|kt|ya?ml|json|md|html?|ts|js)$/.test(key) ||
        /^(www|https?)\./.test(key)
      )
        continue;
      const readers = bindings
        .filter((b) => (b.prefix ? key === b.key || key.startsWith(`${b.key}.`) : key === b.key))
        .map((b) => ({
          type: b.type,
          file: b.file,
          ...(b.line ? { line: b.line } : {}),
          via: b.prefix ? `prefix ${b.key}` : "@Value",
        }));
      if (readers.length > 0) hits.set(key, { key, from: s.from, readers });
    }
  return [...hits.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string) =>
  new RegExp(`(?<![\\w.-])${literal(name)}(?![\\w-]|\\.[\\w])`).test(text);

/** The topics the sources name, by the topic or its property, with where the code listens to them. */
export function topicsNamedIn(
  sources: ReadonlyArray<{ from: string; text: string }>,
  code: CodeContracts,
): TopicHit[] {
  const names = new Set<string>([
    ...code.topics.flatMap((t) => [t.topic, t.property]),
    ...code.listeners.flatMap((l) => (l.topic ? [l.topic] : [])),
  ]);
  const hits: TopicHit[] = [];
  for (const name of [...names].sort()) {
    const source = sources.find((s) => named(s.text, name));
    if (!source) continue;
    const topics = code.topics.filter((t) => t.topic === name || t.property === name);
    const properties = new Set(topics.map((t) => t.property));
    const values = new Set([name, ...topics.map((t) => t.topic)]);
    const listeners = code.listeners.filter(
      (l) =>
        (l.property && (properties.has(l.property) || l.property === name)) ||
        (l.topic && values.has(l.topic)),
    );
    const senders = (code.senders ?? [])
      .filter((s) => s.topics.some((t) => topics.includes(t)))
      .map((s) => s.type);
    hits.push({ name, from: source.from, topics, listeners, ...(senders.length > 0 ? { senders } : {}) });
  }
  // a topic named in the sources by its name and by its property too: one hit, by the name
  const seen = new Set<string>();
  return hits
    .sort(
      (a, b) =>
        Number(b.topics.some((t) => t.topic === b.name)) - Number(a.topics.some((t) => t.topic === a.name)),
    )
    .filter((h) => {
      const key = h.topics.length > 0 ? h.topics.map((t) => `${t.file}|${t.property}`).join(",") : h.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
