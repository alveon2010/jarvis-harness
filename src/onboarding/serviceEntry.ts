import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";

/**
 * What `jarvis onboard` writes into a service's entry of the knowledge repository's map (ADR-0025 §2):
 * its kind and the commands the scan found, each only where nothing is set — neither under the service
 * nor in the shared configuration above it. What a person wrote stays as it is.
 */
export type ServiceKind = "backend" | "frontend";

const FRONTEND = new Set(["react", "vue", "angular", "svelte", "nextjs"]);
const BACKEND = new Set(["java", "kotlin", "dotnet", "csharp", "go", "python", "rust", "node"]);

/** frontend by its framework, backend by a server stack; undefined when neither shows. */
export function kindOf(stacks: readonly string[]): ServiceKind | undefined {
  if (stacks.some((s) => FRONTEND.has(s))) return "frontend";
  if (stacks.some((s) => BACKEND.has(s))) return "backend";
  return undefined;
}

export interface FilledEntry {
  readonly text: string;
  /** What was added, as paths: `kind`, `tools.local.tests`. */
  readonly added: readonly string[];
  /** Found, not written: set already to something else (`tools.local.tests: shared`). */
  readonly kept: readonly string[];
}

const keyOf = (map: YAMLMap, key: string): boolean =>
  map.items.some((p) => isScalar(p.key) && p.key.value === key);

/** The text of `project.yaml` with the service's entry filled in; the same text when nothing is new. */
export function fillServiceEntry(
  text: string,
  service: string,
  found: { readonly kind?: ServiceKind; readonly commands: ReadonlyArray<{ name: string; command: string }> },
): FilledEntry {
  const doc = parseDocument(text);
  const services = doc.get("services", true);
  if (!isMap(services)) return { text, added: [], kept: [] };
  const added: string[] = [];
  const kept: string[] = [];
  const shared = doc.getIn(["tools", "local"], true);
  const sharedLocal = isMap(shared) ? shared : undefined;
  const before = doc.getIn(["services", service], true);
  const own = isMap(before) ? before : undefined;
  // what is there keeps its style; what was empty (`orders-api: {}  # gradle`) becomes a block
  const empty = !own || own.items.length === 0;
  const had = (path: string[]) => doc.hasIn(["services", service, ...path]);
  const hadTools = had(["tools"]);
  const hadLocal = had(["tools", "local"]);
  const set = (path: string[], value: unknown) => {
    doc.setIn(["services", service, ...path], value);
    added.push(path.join("."));
  };
  if (found.kind) {
    if (!own || !keyOf(own, "kind")) set(["kind"], found.kind);
    else if (doc.getIn(["services", service, "kind"]) !== found.kind) kept.push("kind");
  }
  for (const c of found.commands) {
    const path = ["tools", "local", c.name];
    // said only where what is set differs from what the scan found
    if (had(path)) {
      if (doc.getIn(["services", service, ...path]) !== c.command)
        kept.push(`${path.join(".")}: the service's`);
    } else if (sharedLocal && keyOf(sharedLocal, c.name)) {
      if (doc.getIn(["tools", "local", c.name]) !== c.command) kept.push(`${path.join(".")}: shared`);
    } else set(path, c.command);
  }
  if (added.length === 0) return { text, added, kept };
  const block = (path: string[], when: boolean) => {
    const n = doc.getIn(["services", service, ...path], true);
    if (when && isMap(n)) {
      n.flow = false;
      n.comment = null;
    }
  };
  block([], empty);
  block(["tools"], !hadTools);
  block(["tools", "local"], !hadLocal);
  return { text: doc.toString({ lineWidth: 0 }), added, kept };
}
