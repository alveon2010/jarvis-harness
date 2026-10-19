import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPlainObject } from "../core/config/merge.ts";
import { knowledgeConfigOf } from "../core/config/meta.ts";
import type { Run } from "../core/domain/run.ts";
import { metaConfigFile } from "../core/paths.ts";
import { type Catalog, type CatalogLink, catalogOf, type ServiceContracts } from "../knowledge/catalog.ts";
import { parseFrontMatter } from "../knowledge/frontmatter.ts";
import { type FoundRepo, findServiceRepos, stackOf } from "../onboarding/serviceRepos.ts";

/**
 * The services of a knowledge repository as a person checks them (ADR-0025): what each one is, where
 * its repository is on this machine, which checks the agents run in it, what it serves and uses of the
 * others. Read from the map (`project.yaml`), the service's documents and the contract catalog — the
 * same files the agents read, no model. What is missing is said: a service without commands is
 * changed with no tests run, one without a description is guessed at.
 */
export const SERVICE_CHECKS = ["tests", "typecheck", "lint"] as const;

export interface ServiceTool {
  readonly name: string;
  readonly command: string;
  /** Under the service's entry, or the shared `tools.local` above the services. */
  readonly from: "service" | "shared";
}

export interface ServiceRunView {
  readonly id: string;
  readonly task: string;
  readonly workflow: string;
  readonly state: Run["state"];
  readonly updatedAt: string;
}

export interface ServiceView {
  readonly name: string;
  readonly kind?: string;
  /** From the generated architecture's «Stacks» line, else from the build file. */
  readonly stack?: string;
  readonly repo: string;
  readonly present: boolean;
  /** The service's commands: `tools.local` of its entry over the shared one. */
  readonly tools: readonly ServiceTool[];
  /** Of tests, typecheck and lint, the ones with no command. */
  readonly missing: readonly string[];
  /** `knowledge/services/<name>/architecture.md`, relative to the knowledge repository. */
  readonly architecture: string;
  readonly hasArchitecture: boolean;
  /** The first paragraph under its title: what the service is, as a person wrote it. */
  readonly about?: string;
  /** The rest of the description, paragraphs before the first section. */
  readonly more: readonly string[];
  readonly docs: number;
  /** Documents of modules (tagged `module`). */
  readonly modules: number;
  readonly contracts?: ServiceContracts;
  /** Links where the service is one end. */
  readonly links: readonly CatalogLink[];
  readonly runs: readonly ServiceRunView[];
}

export interface ServicesView {
  readonly metaRoot: string;
  readonly configFile: string;
  /** The service whose repository `jarvis ui` runs in, if any. */
  readonly current?: string;
  readonly services: readonly ServiceView[];
  /** Links between services of the map. */
  readonly links: readonly CatalogLink[];
  /** Git repositories next to the knowledge repository not in the map. */
  readonly unmapped: readonly FoundRepo[];
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const strip = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The paragraphs between the title and the first section, without the generated parts: the marker
 * line, lists, tables. A generated architecture has none — it starts with «## Stack».
 */
export function descriptionOf(markdown: string): string[] {
  const { body } = parseFrontMatter(markdown);
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push(strip(para.join(" ")));
    para = [];
  };
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (/^##\s/.test(t)) break;
    if (t === "" || /^#\s/.test(t) || t.startsWith("<!--")) {
      flush();
      continue;
    }
    if (/^([-*+]|\d+\.)\s|^\||^```|^>/.test(t)) {
      flush();
      continue;
    }
    para.push(t);
  }
  flush();
  return out.filter((p) => p.length > 0);
}

/** «- Stacks: java, spring; package manager gradle» of a generated architecture. */
export function stacksLineOf(markdown: string): string | undefined {
  const m = /^- Stacks: ([^\n;]+)(?:; package manager (\S+))?/m.exec(markdown);
  if (!m || m[1] === "none found") return undefined;
  return [m[2], m[1]].filter(Boolean).join(" · ");
}

function docsIn(dir: string): { docs: number; modules: number } {
  let docs = 0;
  let modules = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let names: Dirent[];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.isDirectory()) walk(join(d, e.name), depth + 1);
      else if (e.name.endsWith(".md")) {
        docs++;
        const tags = parseFrontMatter(read(join(d, e.name)) ?? "").data.tags;
        if (Array.isArray(tags) && tags.includes("module")) modules++;
      }
    }
  };
  walk(dir, 0);
  return { docs, modules };
}

const localTools = (o: unknown): Record<string, string> => {
  const tools = isPlainObject(o) ? o.tools : undefined;
  const local = isPlainObject(tools) ? tools.local : undefined;
  return isPlainObject(local)
    ? Object.fromEntries(Object.entries(local).filter((e): e is [string, string] => typeof e[1] === "string"))
    : {};
};

export function servicesOf(input: {
  readonly metaRoot: string;
  readonly repos: Readonly<Record<string, string>>;
  readonly runs: readonly Run[];
  /** The repository `jarvis ui` runs in. */
  readonly projectRoot?: string;
  readonly catalog?: Catalog;
}): ServicesView {
  const { metaRoot, repos } = input;
  const config = knowledgeConfigOf(metaRoot) ?? {};
  const entries = isPlainObject(config.services) ? config.services : {};
  const shared = localTools(config);
  const catalog = input.catalog ?? catalogOf(metaRoot);
  const names = Object.keys(repos).sort((a, b) => a.localeCompare(b));
  const byRepo = new Map<string, Run[]>();
  for (const run of input.runs) {
    const at = real(run.workspace.repoRoot);
    byRepo.set(at, [...(byRepo.get(at) ?? []), run]);
  }
  const services = names.map((name): ServiceView => {
    const entry = entries[name];
    const repo = repos[name] as string;
    const present = existsSync(repo);
    const own = localTools(entry);
    const tools: ServiceTool[] = [
      ...Object.entries(own).map(([n, command]) => ({ name: n, command, from: "service" as const })),
      ...Object.entries(shared)
        .filter(([n]) => !(n in own))
        .map(([n, command]) => ({ name: n, command, from: "shared" as const })),
    ];
    const dir = join(metaRoot, "knowledge", "services", name);
    const architecture = `knowledge/services/${name}/architecture.md`;
    const text = read(join(metaRoot, architecture));
    const [about, ...more] = text ? descriptionOf(text) : [];
    const kind = isPlainObject(entry) && typeof entry.kind === "string" ? entry.kind : undefined;
    const stack = (text ? stacksLineOf(text) : undefined) ?? (present ? stackOf(repo) : undefined);
    const runs = (byRepo.get(real(repo)) ?? [])
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
      .map((r) => ({ id: r.id, task: r.task, workflow: r.workflow, state: r.state, updatedAt: r.updatedAt }));
    const contracts = catalog.services.get(name);
    return {
      name,
      ...(kind ? { kind } : {}),
      ...(stack ? { stack } : {}),
      repo,
      present,
      tools,
      missing: SERVICE_CHECKS.filter((c) => !tools.some((t) => t.name === c)),
      architecture,
      hasArchitecture: text !== undefined,
      ...(about ? { about } : {}),
      more,
      ...docsIn(dir),
      ...(contracts ? { contracts } : {}),
      links: catalog.links.filter((l) => l.producer === name || l.consumer === name),
      runs,
    };
  });
  const reposDir = resolve(metaRoot, typeof config.repos === "string" ? config.repos : "..");
  const mapped = new Set(names);
  const current = input.projectRoot
    ? names.find((n) => real(repos[n] as string) === real(input.projectRoot as string))
    : undefined;
  return {
    metaRoot,
    configFile: metaConfigFile(metaRoot),
    ...(current ? { current } : {}),
    services,
    links: catalog.links.filter((l) => mapped.has(l.producer) && mapped.has(l.consumer)),
    unmapped: findServiceRepos(reposDir, metaRoot, mapped).filter((r) => !r.mapped),
  };
}

/** What is left to do across the map: services with no command for a check, or no description. */
export function servicesToFinish(view: ServicesView): {
  readonly noTools: readonly string[];
  readonly noAbout: readonly string[];
  readonly absent: readonly string[];
} {
  const here = view.services.filter((s) => s.present);
  return {
    noTools: here.filter((s) => s.missing.length > 0).map((s) => s.name),
    noAbout: view.services.filter((s) => !s.about).map((s) => s.name),
    absent: view.services.filter((s) => !s.present).map((s) => s.name),
  };
}
