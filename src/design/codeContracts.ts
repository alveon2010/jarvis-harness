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
      ...(m.direction === "out" ? { direction: "out" as const } : { direction: "in" as const }),
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
  return { endpoints, topics, listeners };
}

export interface TopicHit {
  readonly name: string;
  readonly from: string;
  readonly topics: readonly TopicEntry[];
  readonly listeners: readonly ListenerEntry[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string) =>
  new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-]|\\.[\\w])`).test(text);

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
    hits.push({ name, from: source.from, topics, listeners });
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
