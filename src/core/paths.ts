import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Layout of `~/.jarvis` (ADR-0001 §3). */
export interface JarvisHome {
  readonly root: string;
  readonly configFile: string;
  readonly dbFile: string;
  readonly runsDir: string;
  readonly artifactsDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly worktreesDir: string;
  readonly socketFile: string;
}

export function jarvisHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): JarvisHome {
  const root = resolve(env.JARVIS_HOME ?? join(home, ".jarvis"));
  return {
    root,
    configFile: env.JARVIS_CONFIG ? resolve(env.JARVIS_CONFIG) : join(root, "config.yaml"),
    dbFile: join(root, "jarvis.db"),
    runsDir: join(root, "runs"),
    artifactsDir: join(root, "artifacts"),
    cacheDir: join(root, "cache"),
    logsDir: env.JARVIS_LOG_DIR ? resolve(env.JARVIS_LOG_DIR) : join(root, "logs"),
    worktreesDir: join(root, "worktrees"),
    socketFile: join(root, "daemon.sock"),
  };
}

/**
 * Layout of `<project>/.jarvis` (ADR-0001 §3). For a service of a knowledge repository (ADR-0025)
 * `root` is still the code — the service's repository — while Jarvis's own files live in the
 * knowledge repository: `jarvisDir` and `configFile` there, `knowledgeDir` its
 * `knowledge/services/<service>/`.
 */
export interface ProjectPaths {
  readonly root: string;
  readonly jarvisDir: string;
  readonly configFile: string;
  readonly knowledgeDir: string;
  readonly specsDir: string;
  readonly approvalsDir: string;
  readonly hasConfig: boolean;
  readonly isGitRepo: boolean;
  /** The glossary: the knowledge directory's, or the knowledge repository's shared one. */
  readonly glossaryFile: string;
  /** Set when the Jarvis files live in a knowledge repository. */
  readonly meta?: MetaPaths;
}

/** Where a project's Jarvis files are when they live in a knowledge repository (ADR-0025 §1). */
export interface MetaPaths {
  /** The knowledge repository. */
  readonly root: string;
  /** Its `knowledge/`: shared documents at the top, a folder per service under `services/`. */
  readonly knowledgeRoot: string;
  /** The service `root` is; none when the knowledge repository itself is the project. */
  readonly service?: string;
}

export const PROJECT_DIR = ".jarvis";
export const PROJECT_CONFIG = "project.yaml";

export function projectPaths(root: string): ProjectPaths {
  const jarvisDir = join(root, PROJECT_DIR);
  const configFile = join(jarvisDir, PROJECT_CONFIG);
  const knowledgeDir = join(jarvisDir, "knowledge");
  return {
    root,
    jarvisDir,
    configFile,
    knowledgeDir,
    specsDir: join(jarvisDir, "specs"),
    approvalsDir: join(jarvisDir, "approvals"),
    hasConfig: existsSync(configFile),
    isGitRepo: existsSync(join(root, ".git")),
    glossaryFile: join(knowledgeDir, "glossary.md"),
  };
}

/**
 * Where a knowledge repository keeps Jarvis's files: `.jarvis/` when it has one, else its root — the
 * repository is Jarvis's only, so `project.yaml`, `knowledge/`, `workflows/`… may lie at the top.
 */
export function metaJarvisDir(metaRoot: string): string {
  return existsSync(join(metaRoot, PROJECT_CONFIG)) &&
    !existsSync(join(metaRoot, PROJECT_DIR, PROJECT_CONFIG))
    ? metaRoot
    : join(metaRoot, PROJECT_DIR);
}

/** A knowledge repository's `project.yaml`: at its root, or in its `.jarvis/`. */
export const metaConfigFile = (metaRoot: string): string => join(metaJarvisDir(metaRoot), PROJECT_CONFIG);

/**
 * The paths of a project whose Jarvis files live in the knowledge repository `metaRoot`: the code in
 * `root` (a service's repository, or the knowledge repository itself when `service` is undefined).
 */
export function metaProjectPaths(root: string, metaRoot: string, service: string | undefined): ProjectPaths {
  const jarvisDir = metaJarvisDir(metaRoot);
  const knowledgeRoot = join(metaRoot, "knowledge");
  return {
    root,
    jarvisDir,
    configFile: join(jarvisDir, PROJECT_CONFIG),
    knowledgeDir: service ? join(knowledgeRoot, "services", service) : knowledgeRoot,
    specsDir: join(jarvisDir, "specs"),
    approvalsDir: service ? join(jarvisDir, "approvals", service) : join(jarvisDir, "approvals"),
    hasConfig: true,
    isGitRepo: existsSync(join(root, ".git")),
    glossaryFile: join(knowledgeRoot, "glossary.md"),
    meta: { root: metaRoot, knowledgeRoot, ...(service ? { service } : {}) },
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the project root by walking up from `cwd`: the first directory containing
 * `.jarvis/project.yaml`, otherwise the first containing `.git`. Returns undefined when neither exists.
 */
export function discoverProject(cwd: string): ProjectPaths | undefined {
  let dir = resolve(cwd);
  let gitRoot: string | undefined;
  for (;;) {
    if (existsSync(join(dir, PROJECT_DIR, PROJECT_CONFIG))) return projectPaths(dir);
    if (gitRoot === undefined && isDir(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ? projectPaths(gitRoot) : undefined;
}

/**
 * The repository a checkout belongs to: a run's clone names it in `.git/jarvis-main`, a worktree's
 * `.git` file points into its `.git/worktrees/`; anything else is its own.
 */
export function mainCheckoutOf(path: string): string {
  try {
    const dotGit = join(path, ".git");
    // a run's clone (workspace.checkout: clone) names the repository it came from
    const named = join(dotGit, "jarvis-main");
    if (existsSync(named)) return readFileSync(named, "utf8").trim() || path;
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      const m = pointer ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(pointer) : undefined;
      if (m?.[1]) return m[1];
    }
  } catch {
    // not a git checkout: the path itself identifies the repository
  }
  return path;
}

const layouts = new Map<string, ProjectPaths>();

/**
 * Remembers where a project's Jarvis files are, as loading the configuration found them, so code
 * that has only a root (a run's checkout, a page's repository) reads knowledge, workflows and
 * standards from the same place.
 */
export function rememberLayout(paths: ProjectPaths): void {
  layouts.set(resolve(paths.root), paths);
}

/** Tests: start from no remembered layouts. */
export function forgetLayouts(): void {
  layouts.clear();
}

/**
 * Where the Jarvis files of the project at `root` are: `<root>/.jarvis`, or — for a service of a
 * knowledge repository, its run checkouts included — the knowledge repository's (ADR-0025 §1).
 */
export function layoutOf(root: string): ProjectPaths {
  const at = resolve(root);
  const known = layouts.get(at);
  if (known) return known;
  // a run's checkout of a service: the service's layout, with the checkout as the code
  const main = layouts.get(resolve(mainCheckoutOf(at)));
  if (main?.meta) return { ...main, root: at, isGitRepo: existsSync(join(at, ".git")) };
  return projectPaths(at);
}

/**
 * A Jarvis file as pages and commands name it: relative to the code root — `.jarvis/knowledge/a.md`,
 * or for a service `../jarvis-knowledge/knowledge/services/orders-api/a.md` (joined with the root it
 * is the file again).
 */
export function rootRelative(root: string, file: string): string {
  return relative(resolve(root), resolve(file)).split(sep).join("/");
}

/** The repository a Jarvis file is versioned in and its path there: the knowledge repository's for a service. */
export function versionedAt(
  layout: ProjectPaths,
  rel: string,
): { readonly cwd: string; readonly path: string } {
  const abs = resolve(layout.root, rel);
  const meta = layout.meta?.root;
  return meta && (abs === meta || abs.startsWith(meta + sep))
    ? { cwd: meta, path: relative(meta, abs).split(sep).join("/") }
    : { cwd: layout.root, path: rel };
}
