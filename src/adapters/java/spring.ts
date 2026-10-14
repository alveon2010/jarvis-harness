import { isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments } from "yaml";
import type { GraphNode } from "../../core/capabilities/contracts.ts";
import { blankLiterals } from "./source.ts";

/**
 * The contracts of a Spring service its code and config state, read without a compiler: the HTTP
 * endpoints of its controllers (`@GetMapping`… under a class `@RequestMapping`) and the ones it calls
 * through Feign clients, the Kafka topics its `application*.yml` names and where the code listens to
 * them. Graph nodes (`Endpoint`, `Event`) the sources step checks a task's `METHOD /path` and topic
 * names against. In a Spring service of ~500 files, which route serves a method and which topic a
 * listener reads are otherwise a search an agent repeats on every run.
 */

const VERBS: Record<string, string | undefined> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: undefined,
};
const ANNOTATION =
  /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping|FeignClient|KafkaListener)\b/g;
const TYPE = /\b(class|interface|record|enum)\s+([A-Z]\w*)/g;

/** The text between the parentheses that open at `start`, or undefined (no arguments). */
function argsAt(code: string, start: number): { text: string; end: number } | undefined {
  let i = start;
  while (i < code.length && /\s/.test(code[i] as string)) i += 1;
  if (code[i] !== "(") return undefined;
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    const c = code[j];
    if (c === '"') {
      j += 1;
      while (j < code.length && code[j] !== '"') j += code[j] === "\\" ? 2 : 1;
    } else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return { text: code.slice(i + 1, j), end: j + 1 };
    }
  }
  return undefined;
}

const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string);

/** An attribute's strings (`path = {"a", "b"}`), or the bare first argument's (`("a")`). */
function attr(args: string | undefined, names: readonly string[], bare: boolean): string[] {
  if (!args) return [];
  for (const name of names) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(\\{[^}]*\\}|"(?:[^"\\\\]|\\\\.)*")`).exec(args);
    if (m) return strings(m[1] as string);
  }
  if (!bare) return [];
  const first = /^\s*(\{[^}]*\}|"(?:[^"\\]|\\.)*")/.exec(args);
  return first ? strings(first[1] as string) : [];
}

function joinPath(prefix: string, path: string): string {
  const joined = `/${[prefix, path]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")}`;
  return joined;
}

/** The method an annotation stands on: the first `name(` after it and the annotations that follow. */
function handlerAfter(code: string, from: number): string | undefined {
  const rest = code.slice(from, from + 600).replace(/@[\w.]+(\s*\((?:[^()]|\([^()]*\))*\))?/g, " ");
  return /\b([a-z]\w*)\s*\(/.exec(rest)?.[1];
}

/**
 * A controller's endpoints and listeners; `route` and `base` when its class maps a route and
 * extends another (`@RequestMapping("/orders") class OrderController extends BaseController`): the
 * base's endpoints are served under the route (`inherited` endpoints, `routesOf` in the sources step).
 */
export function springFacts(
  file: string,
  content: string,
): { nodes: GraphNode[]; route?: string; base?: string } {
  if (!/@(\w+Mapping|FeignClient|KafkaListener)\b/.test(content)) return { nodes: [] };
  const code = blankLiterals(content, true);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const types = [...code.matchAll(TYPE)].map((m) => ({
    kind: m[1] as string,
    name: m[2] as string,
    at: m.index ?? 0,
  }));
  const first = types[0];
  const typeAt = (at: number) => [...types].reverse().find((t) => t.at < at)?.name ?? first?.name ?? "";
  let prefix = "";
  let route: string | undefined;
  let client: string | undefined;
  const nodes: GraphNode[] = [];
  // the endpoints of an abstract class are served by its subclasses, under their routes
  const abstract =
    first !== undefined &&
    /\babstract\s+(?:[\w\s]*\s)?class\s+$/.test(code.slice(Math.max(0, first.at - 80), first.at + 6));
  // an interface with mappings and no controller annotation: the client of another service (Feign
  // declared elsewhere, an HTTP interface) — controllers are classes
  const asClient = first?.kind === "interface" && !/@(Rest)?Controller\b/.test(code);
  const base = first
    ? new RegExp(`\\b${first.name}\\s*(?:<[^{]*?>)?\\s+extends\\s+([A-Z]\\w*)`).exec(code)?.[1]
    : undefined;
  for (const m of code.matchAll(ANNOTATION)) {
    const name = m[1] as string;
    const at = m.index ?? 0;
    const args = argsAt(code, at + m[0].length);
    const classLevel = first !== undefined && at < first.at;
    if (name === "FeignClient") {
      client = attr(args?.text, ["name", "value"], true)[0] ?? "";
      prefix = attr(args?.text, ["path"], false)[0] ?? prefix;
      continue;
    }
    if (name === "KafkaListener") {
      const handler = handlerAfter(code, args?.end ?? at + m[0].length);
      for (const t of attr(args?.text, ["topics", "topicPattern"], false)) {
        const property = /^\$\{([^}:]+)(?::[^}]*)?\}$/.exec(t)?.[1];
        nodes.push({
          id: `${file}#listens ${t}`,
          kind: "Event",
          file,
          metadata: {
            role: "listens",
            ...(property ? { property } : { topic: t }),
            ...(handler ? { handler: `${typeAt(at)}.${handler}` } : {}),
            line: lineAt(at),
          },
        });
      }
      continue;
    }
    const paths = attr(args?.text, ["path", "value"], true);
    if (classLevel) {
      if (name === "RequestMapping") {
        prefix = paths[0] ?? "";
        route = joinPath(prefix, "");
      }
      continue;
    }
    const methods = VERBS[name]
      ? [VERBS[name] as string]
      : [...(args?.text ?? "").matchAll(/RequestMethod\.([A-Z]+)/g)].map((x) => x[1] as string);
    const handler = handlerAfter(code, args?.end ?? at + m[0].length);
    for (const path of paths.length > 0 ? paths : [""])
      for (const method of methods.length > 0 ? methods : [undefined]) {
        const full = joinPath(prefix, path);
        nodes.push({
          id: `${file}#${method ? `${method} ` : ""}${full}`,
          kind: "Endpoint",
          file,
          metadata: {
            ...(method ? { method } : {}),
            path: full,
            ...(handler ? { handler: `${typeAt(at)}.${handler}` } : {}),
            direction: client !== undefined || asClient ? "out" : "in",
            ...(client ? { client } : {}),
            ...(abstract ? { inherited: true } : {}),
            line: lineAt(at),
          },
        });
      }
  }
  return { nodes, ...(route !== undefined && base ? { route, base } : {}) };
}

/** Keys under a `topic(s)` or `destination` key that are not topic names. */
const NOT_A_TOPIC =
  /^(group(-?id)?|system-?name|partitions?|replicas?|replication-factor|retention.*|enabled|concurrency|key|value|type|format|.*-?(timeout|interval|size|count)s?)$/i;

/** A Spring config file: `application*.yml`, `bootstrap*.yml` under a resources directory. */
export const SPRING_CONFIG =
  /(^|\/)src\/[^/]+\/resources\/(?:config\/)?(application|bootstrap)[\w-]*\.ya?ml$/;

/**
 * The topics a Spring config names: string values under a `topic`/`topics` key (any depth) or a
 * stream binding's `destination`, each with its property path. A list of them is one node per item.
 */
export function topicFacts(file: string, content: string): GraphNode[] {
  const counter = new LineCounter();
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(content, { lineCounter: counter, uniqueKeys: false });
  } catch {
    return [];
  }
  if (!Array.isArray(docs)) return [];
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const visit = (node: Node | null | undefined, path: string[], underTopic: boolean) => {
    if (!node) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
        if (key === undefined) continue;
        const topical = underTopic || /^topics?$/i.test(key) || /^destination$/i.test(key);
        visit(pair.value as Node, [...path, key], topical);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        visit(item as Node, [...path, String(i)], underTopic);
      });
    } else if (isScalar(node) && underTopic && typeof node.value === "string" && node.value.trim()) {
      const last = path.filter((p) => !/^\d+$/.test(p)).at(-1) ?? "";
      if (NOT_A_TOPIC.test(last) || (/\$\{/.test(node.value) && !/^[\w.-]+$/.test(node.value))) return;
      const property = path.join(".");
      const id = `${file}#topic ${property}`;
      if (seen.has(id)) return;
      seen.add(id);
      nodes.push({
        id,
        kind: "Event",
        file,
        metadata: {
          role: "topic",
          property,
          topic: node.value.trim(),
          line: counter.linePos(node.range?.[0] ?? 0).line,
        },
      });
    }
  };
  // profiles of one file (`---`): each document's topics, a property once
  for (const d of docs) visit(d.contents as Node, [], false);
  return nodes;
}

const REPOSITORY =
  /\binterface\s+([A-Z]\w*)\s*(?:<[^{]*?>)?\s+extends\s+[^{]*?\b(?:Mongo|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Reactive\w*|Jpa)Repository\s*<\s*([A-Z]\w*)/;

/**
 * What a class binds and stores, read off its annotations: the config it reads
 * (`@ConfigurationProperties` prefix, `@Value("${…}")` properties), the Mongo collection of a
 * `@Document`, the entity of a Spring Data repository, and whether it sends messages (a
 * `KafkaTemplate` / `StreamBridge` `send`) with the topic properties it reads. Where a config key
 * is read and which class writes a collection are otherwise a search through the whole service.
 */
export function springBindings(file: string, content: string): GraphNode[] {
  if (!/@(ConfigurationProperties|Value|Document)\b|Repository\s*<|\.send\s*\(/.test(content)) return [];
  const code = blankLiterals(content, true);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const type = TYPE.exec(code)?.[2] ?? file.replace(/^.*\//, "").replace(/\.\w+$/, "");
  TYPE.lastIndex = 0;
  const nodes: GraphNode[] = [];
  const add = (key: string, kind: GraphNode["kind"], at: number, metadata: Record<string, unknown>) => {
    const id = `${file}#${key}`;
    if (!nodes.some((n) => n.id === id))
      nodes.push({ id, kind, file, metadata: { ...metadata, type, line: lineAt(at) } });
  };
  for (const m of code.matchAll(/@ConfigurationProperties\b/g)) {
    const prefix = attr(argsAt(code, (m.index ?? 0) + m[0].length)?.text, ["prefix", "value"], true)[0];
    if (prefix) add(`config ${prefix}`, "Symbol", m.index ?? 0, { role: "config", prefix });
  }
  const read: string[] = [];
  for (const m of code.matchAll(/@Value\b/g)) {
    for (const v of attr(argsAt(code, (m.index ?? 0) + m[0].length)?.text, ["value"], true))
      for (const p of v.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)) {
        const property = p[1] as string;
        read.push(property);
        add(`value ${property}`, "Symbol", m.index ?? 0, { role: "config", property });
      }
  }
  for (const m of code.matchAll(/@Document\b/g)) {
    const named = attr(argsAt(code, (m.index ?? 0) + m[0].length)?.text, ["collection", "value"], true)[0];
    // Spring's default: the class name, first letter lower
    const collection = named ?? `${type.slice(0, 1).toLowerCase()}${type.slice(1)}`;
    add(`collection ${collection}`, "DataModel", m.index ?? 0, { role: "collection", collection });
  }
  const repo = REPOSITORY.exec(code);
  if (repo)
    add("repository", "DataModel", repo.index, { role: "repository", repository: repo[1], entity: repo[2] });
  const send =
    /\b(KafkaTemplate|StreamBridge)\b[\s\S]*?\.send\s*\(|\.send\s*\([\s\S]*\b(KafkaTemplate|StreamBridge)\b/.test(
      code,
    )
      ? /\.send\s*\(/.exec(code)
      : null;
  // the topic a sender writes is often a config key in a string (`topics.get("orders-paid")`): its
  // strings that look like keys, for the tree to match against the topics' properties
  const keys = [...new Set([...code.matchAll(/"([a-z][\w.-]{2,80})"/g)].map((k) => k[1] as string))]
    .sort()
    .slice(0, 60);
  if (send)
    add("sends", "Event", send.index, {
      role: "sends",
      ...(read.length > 0 ? { properties: [...new Set(read)].sort() } : {}),
      ...(keys.length > 0 ? { keys } : {}),
    });
  return nodes;
}
