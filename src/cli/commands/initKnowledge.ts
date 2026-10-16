import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { knowledgeConfigOf, serviceRepos } from "../../core/config/meta.ts";
import { ServiceNameSchema } from "../../core/config/schema.ts";
import { metaProjectPaths, PROJECT_CONFIG, PROJECT_DIR } from "../../core/paths.ts";
import { git } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { KNOWLEDGE_README, PROJECT_CONFIG_TEMPLATE, SKILLS_README, STANDARDS_README } from "../templates.ts";
import { runInit } from "./init.ts";

/**
 * `jarvis init --knowledge` (ADR-0025 §1–2): the current folder becomes a knowledge repository with its
 * files at the top — `project.yaml`, `knowledge/`, `standards/`, `skills/` — and a first map of
 * services: every git repository next to it (or under `--repos`), by its folder name. Nothing is
 * read in them but which folder is a repository and its build file; their code is `jarvis onboard`'s.
 * The map is a draft to edit. Run again, it writes nothing over and lists what the map has not yet.
 */
export interface FoundRepo {
  readonly name: string;
  readonly path: string;
  /** From its build file: gradle, maven, node, go, python. */
  readonly stack?: string;
  /** It has a `.jarvis/` of its own: it works on its own until that is removed. */
  readonly ownJarvis: boolean;
  /** Already in the knowledge repository's map. */
  readonly mapped: boolean;
}

export interface InitKnowledgeReport {
  readonly root: string;
  readonly reposDir: string;
  readonly configFile: string;
  /** The map was written now (a new project.yaml); otherwise the new ones are only listed. */
  readonly wroteMap: boolean;
  readonly repos: readonly FoundRepo[];
  readonly created: string[];
  readonly skipped: string[];
  readonly gitInit: boolean;
}

const STACKS: ReadonlyArray<readonly [string, string]> = [
  ["build.gradle.kts", "gradle"],
  ["build.gradle", "gradle"],
  ["pom.xml", "maven"],
  ["package.json", "node"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
];

const stackOf = (dir: string): string | undefined => STACKS.find(([f]) => existsSync(join(dir, f)))?.[1];

/** The git repositories under `reposDir`, but the knowledge repository and any other one. */
export function findServiceRepos(
  reposDir: string,
  knowledgeRoot: string,
  mapped: ReadonlySet<string>,
): FoundRepo[] {
  let names: string[] = [];
  try {
    names = readdirSync(reposDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const out: FoundRepo[] = [];
  for (const name of names) {
    const path = join(reposDir, name);
    if (resolve(path) === resolve(knowledgeRoot)) continue;
    if (!existsSync(join(path, ".git"))) continue;
    if (!ServiceNameSchema.safeParse(name).success) continue;
    if (knowledgeConfigOf(path)) continue;
    const stack = stackOf(path);
    out.push({
      name,
      path,
      ...(stack ? { stack } : {}),
      ownJarvis: existsSync(join(path, PROJECT_DIR, PROJECT_CONFIG)),
      mapped: mapped.has(name),
    });
  }
  return out;
}

const HEADER = `# project.yaml — the knowledge repository of many services (ADR-0025). Versioned here only: the
# services' repositories keep no Jarvis files. Next to it: knowledge/ (shared documents at the top, a
# folder per service under services/), standards/, skills/, workflows/.
`;

/** One line of the map: the service, and what its folder said. */
export function mapLine(r: FoundRepo): string {
  const notes = [
    r.stack,
    r.ownJarvis ? "has its own .jarvis/: works on its own until it is removed" : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(" — ");
  const entry = `  ${r.name}: {}`;
  return notes ? `${entry.padEnd(32)}# ${notes}` : entry;
}

function mapBlock(repos: readonly FoundRepo[], reposRel: string | undefined): string {
  const lines = [
    ...(reposRel
      ? [`repos: ${reposRel}               # where the services' repositories lie, from here`]
      : []),
    "# crossRepos: { maxParallel: 2 }   # subtasks of a task across services run at once",
    "",
    "# One entry per service: the folder of its repository under repos (else repo: <folder>); its own",
    "# settings under its name (tools, roles, …) go over the shared ones above. A draft: remove what is",
    "# not a service.",
    "services:",
    ...(repos.length > 0 ? repos.map(mapLine) : ["  # orders-api: {}"]),
  ];
  return `${lines.join("\n")}\n`;
}

/** The configuration's text: the header, the usual project template, the map. */
function configText(repos: readonly FoundRepo[], reposRel: string | undefined): string {
  const body = PROJECT_CONFIG_TEMPLATE.split("\n").slice(1).join("\n");
  return `${HEADER}${body.endsWith("\n") ? body : `${body}\n`}\n${mapBlock(repos, reposRel)}`;
}

export async function runInitKnowledge(
  ctx: CliContext,
  options: { readonly repos?: string; readonly projectOnly?: boolean } = {},
): Promise<InitKnowledgeReport> {
  const root = resolve(ctx.cwd);
  if (existsSync(join(root, PROJECT_DIR, PROJECT_CONFIG)) && !knowledgeConfigOf(root))
    throw new Error(
      `${root} has a .jarvis/ of its own: a knowledge repository is a repository of its own — run this in a new folder next to the services`,
    );
  const created: string[] = [];
  const skipped: string[] = [];
  if (!options.projectOnly) {
    const home = await runInit(ctx, { userOnly: true });
    created.push(...home.created);
    skipped.push(...home.skipped);
  }
  const existing = knowledgeConfigOf(root);
  const reposDir = resolve(
    root,
    options.repos ?? (existing && typeof existing.repos === "string" ? existing.repos : ".."),
  );
  const mapped = new Set(existing ? Object.keys(serviceRepos(root, existing, undefined, ctx.homeDir)) : []);
  const repos = findServiceRepos(reposDir, root, mapped);
  // a new knowledge repository has its files at the top; one with .jarvis/ keeps it
  const layout = metaProjectPaths(root, root, undefined);
  const configFile = existing ? layout.configFile : join(root, PROJECT_CONFIG);
  const jarvisDir = existing ? layout.jarvisDir : root;
  const ensure = (path: string, content?: string) => {
    if (existsSync(path)) return void skipped.push(path);
    if (content === undefined) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    created.push(path);
  };
  let gitInit = false;
  if (!existsSync(join(root, ".git"))) {
    const r = await git(["init", "-q", "-b", "main"], root);
    gitInit = r.code === 0;
    if (gitInit) created.push(join(root, ".git"));
  }
  const reposRel = relative(root, reposDir).split(sep).join("/") || ".";
  const wroteMap = !existing;
  if (wroteMap) ensure(configFile, configText(repos, reposRel === ".." ? undefined : reposRel));
  else skipped.push(configFile);
  const knowledgeRoot = join(root, "knowledge");
  ensure(join(knowledgeRoot, "README.md"), KNOWLEDGE_README);
  ensure(join(knowledgeRoot, "services", ".gitkeep"), "");
  ensure(join(jarvisDir, "standards", "README.md"), STANDARDS_README);
  ensure(join(jarvisDir, "skills", "README.md"), SKILLS_README);
  return { root, reposDir, configFile, wroteMap, repos, created, skipped, gitInit };
}

export function renderInitKnowledge(ctx: CliContext, report: InitKnowledgeReport): void {
  const { out } = ctx;
  const show = (p: string) => {
    const r = relative(report.root, p).split(sep).join("/");
    return r === "" ? "." : r;
  };
  out.line(`knowledge repository: ${report.root}`);
  out.line(`configuration:        ${show(report.configFile)}`);
  const fresh = report.repos.filter((r) => !r.mapped);
  out.line();
  if (report.repos.length === 0) out.line(`no git repositories in ${report.reposDir} — add services by hand`);
  else if (report.wroteMap) {
    out.line(`services mapped (${report.repos.length}, from the git repositories in ${report.reposDir}):`);
    for (const r of report.repos)
      out.line(
        `  ${r.name.padEnd(28)} ${(r.stack ?? "").padEnd(7)} ${r.ownJarvis ? "⚠ has its own .jarvis/" : ""}`.trimEnd(),
      );
  } else if (fresh.length === 0) out.line(`every git repository in ${report.reposDir} is in the map`);
  else {
    out.line(`not in the map yet — add under services: in ${show(report.configFile)} what is a service:`);
    for (const r of fresh) out.line(mapLine(r));
  }
  if (report.created.length > 0) {
    out.line();
    out.line("created:");
    for (const p of report.created) out.line(`  + ${show(p)}`);
  }
  const own = report.repos.filter((r) => r.ownJarvis);
  out.line();
  out.line("next:");
  out.line(`  1. check the map in ${show(report.configFile)}: remove what is not a service`);
  if (own.length > 0) {
    out.line("  2. a repository with its own .jarvis/ works on its own until it is removed — for each:");
    for (const r of own) {
      const at = relative(report.root, r.path).split(sep).join("/");
      out.line(
        `       mkdir -p knowledge/services/${r.name} && mv ${at}/.jarvis/knowledge/* knowledge/services/${r.name}/`,
      );
      out.line(
        `       its ${at}/.jarvis/project.yaml settings under services.${r.name}, then remove ${at}/.jarvis/`,
      );
    }
  }
  out.line(
    `  ${own.length > 0 ? 3 : 2}. in each service: jarvis onboard — its knowledge and contracts.json come here`,
  );
  out.line(
    `  ${own.length > 0 ? 4 : 3}. commit here; jarvis doctor in a service names the knowledge repository it uses`,
  );
}
