import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { PROJECT_CONFIG, PROJECT_DIR } from "../paths.ts";
import { isPlainObject, type PlainObject } from "./merge.ts";

/**
 * A knowledge repository (ADR-0025 §1–3): the one `.jarvis` of many services, each in a repository of
 * its own with no Jarvis files. A run in a service's repository finds the knowledge repository, and
 * in its map the service this repository is.
 */
export const KNOWLEDGE_REPO_ENV = "JARVIS_KNOWLEDGE";
/** The folder name looked for first next to the repositories. */
export const KNOWLEDGE_REPO_NAME = "jarvis-knowledge";

function readProjectFile(root: string): PlainObject | undefined {
  const file = join(root, PROJECT_DIR, PROJECT_CONFIG);
  if (!existsSync(file)) return undefined;
  try {
    const value: unknown = YAML.parse(readFileSync(file, "utf8"));
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a project.yaml is a knowledge repository's: it maps services. */
export function isKnowledgeRepoConfig(value: unknown): boolean {
  return isPlainObject(value) && isPlainObject(value.services);
}

function expandHome(path: string, homeDir: string): string {
  return path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
}

/**
 * The knowledge repository for the repository at `repoRoot`: `JARVIS_KNOWLEDGE`, else
 * `knowledgeRepo` of the personal configuration, else a folder next to it whose project.yaml maps
 * services (`jarvis-knowledge` first). Undefined when there is none.
 */
export function findKnowledgeRepo(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  userKnowledgeRepo: string | undefined,
  homeDir: string,
): string | undefined {
  const named = [env[KNOWLEDGE_REPO_ENV], userKnowledgeRepo].filter((x): x is string => !!x?.trim());
  for (const n of named) {
    const root = resolve(expandHome(n.trim(), homeDir));
    if (isKnowledgeRepoConfig(readProjectFile(root))) return root;
  }
  const parent = dirname(resolve(repoRoot));
  let siblings: string[] = [];
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && join(parent, d.name) !== resolve(repoRoot))
      .map((d) => d.name)
      .sort(
        (a, b) => Number(b === KNOWLEDGE_REPO_NAME) - Number(a === KNOWLEDGE_REPO_NAME) || a.localeCompare(b),
      );
  } catch {
    return undefined;
  }
  for (const name of siblings) {
    const root = join(parent, name);
    if (isKnowledgeRepoConfig(readProjectFile(root))) return root;
  }
  return undefined;
}

/**
 * Each service's repository: `repos.<name>` of the personal configuration, else
 * `services.<name>.repo` (a folder under `repos` or a path relative to it), else the folder `<name>`
 * under `repos` (`..` of the knowledge repository by default).
 */
export function serviceRepos(
  metaRoot: string,
  metaConfig: PlainObject,
  userRepos: Readonly<Record<string, string>> | undefined,
  homeDir: string,
): Record<string, string> {
  const base = resolve(metaRoot, typeof metaConfig.repos === "string" ? metaConfig.repos : "..");
  const services = isPlainObject(metaConfig.services) ? metaConfig.services : {};
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(services)) {
    const own = userRepos?.[name];
    const repo = isPlainObject(def) && typeof def.repo === "string" ? def.repo : name;
    out[name] = own
      ? resolve(expandHome(own, homeDir))
      : isAbsolute(expandHome(repo, homeDir))
        ? expandHome(repo, homeDir)
        : resolve(base, repo);
  }
  return out;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The service whose repository is `repoRoot`, by the map (ADR-0025 §2). */
export function serviceOf(repoRoot: string, repos: Readonly<Record<string, string>>): string | undefined {
  const at = real(repoRoot);
  return Object.entries(repos).find(([, path]) => real(path) === at)?.[0];
}

/** The folder name a repository would be mapped by, for the hint when it is not in the map. */
export function folderOf(repoRoot: string): string {
  return basename(resolve(repoRoot));
}

/**
 * The knowledge repository and service `repoRoot` is, from the personal configuration's text (no full
 * load): for `jarvis init`, which must not create a `.jarvis` in a service's repository.
 */
export function serviceOfRepo(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  userConfigFile: string,
): { readonly metaRoot: string; readonly service: string } | undefined {
  let user: PlainObject = {};
  try {
    const parsed: unknown = YAML.parse(readFileSync(userConfigFile, "utf8"));
    if (isPlainObject(parsed)) user = parsed;
  } catch {
    user = {};
  }
  const metaRoot = findKnowledgeRepo(
    repoRoot,
    env,
    typeof user.knowledgeRepo === "string" ? user.knowledgeRepo : undefined,
    homeDir,
  );
  const metaConfig = metaRoot ? readProjectFile(metaRoot) : undefined;
  if (!metaRoot || !metaConfig) return undefined;
  const repos = serviceRepos(
    metaRoot,
    metaConfig,
    isPlainObject(user.repos) ? (user.repos as Record<string, string>) : undefined,
    homeDir,
  );
  const service = serviceOf(repoRoot, repos);
  return service ? { metaRoot, service } : undefined;
}
