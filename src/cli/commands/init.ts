import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serviceOfRepo } from "../../core/config/meta.ts";
import { discoverProject, jarvisHome, projectPaths } from "../../core/paths.ts";
import { openDatabase } from "../../storage/index.ts";
import type { CliContext } from "../context.ts";
import {
  GITIGNORE_ENTRIES,
  KNOWLEDGE_README,
  PROJECT_CONFIG_TEMPLATE,
  SKILLS_README,
  STANDARDS_README,
  USER_CONFIG_TEMPLATE,
} from "../templates.ts";

export interface InitOptions {
  /** Skip the project part (only set up ~/.jarvis). */
  readonly userOnly?: boolean;
  /** Skip the user part (only set up the project). */
  readonly projectOnly?: boolean;
}

export interface InitReport {
  readonly created: string[];
  readonly skipped: string[];
  readonly home: string;
  readonly project?: string;
  /** The project is a service of a knowledge repository: nothing is created in it. */
  readonly service?: { readonly name: string; readonly knowledgeRepo: string };
  readonly schemaVersion?: number;
}

function ensureFile(path: string, content: string, report: { created: string[]; skipped: string[] }): void {
  if (existsSync(path)) {
    report.skipped.push(path);
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  report.created.push(path);
}

function ensureDir(path: string, report: { created: string[]; skipped: string[] }): void {
  if (existsSync(path)) {
    report.skipped.push(path);
    return;
  }
  mkdirSync(path, { recursive: true });
  report.created.push(path);
}

export async function runInit(ctx: CliContext, options: InitOptions = {}): Promise<InitReport> {
  const created: string[] = [];
  const skipped: string[] = [];
  const report = { created, skipped };
  const home = jarvisHome(ctx.env, ctx.homeDir);
  let schemaVersion: number | undefined;

  if (!options.projectOnly) {
    ensureDir(home.root, report);
    ensureFile(home.configFile, USER_CONFIG_TEMPLATE, report);
    for (const dir of [home.runsDir, home.artifactsDir, home.cacheDir, home.worktreesDir])
      ensureDir(dir, report);
    const opened = openDatabase(home.dbFile);
    schemaVersion = opened.schemaVersion;
    if (opened.applied.length > 0) created.push(`${home.dbFile} (schema v${schemaVersion})`);
    else skipped.push(home.dbFile);
    opened.close();
  }

  let projectRoot: string | undefined;
  let service: InitReport["service"];
  const discovered = options.userOnly ? undefined : discoverProject(ctx.cwd);
  // a service of a knowledge repository keeps no Jarvis files of its own (ADR-0025 §1)
  const ofMeta =
    discovered && !discovered.hasConfig
      ? serviceOfRepo(discovered.root, ctx.env, ctx.homeDir, home.configFile)
      : undefined;
  if (ofMeta && discovered) {
    projectRoot = discovered.root;
    service = { name: ofMeta.service, knowledgeRepo: ofMeta.metaRoot };
  } else if (!options.userOnly) {
    const project = discovered ?? projectPaths(ctx.cwd);
    projectRoot = project.root;
    ensureDir(project.jarvisDir, report);
    ensureFile(project.configFile, PROJECT_CONFIG_TEMPLATE, report);
    ensureDir(project.knowledgeDir, report);
    ensureFile(join(project.knowledgeDir, "README.md"), KNOWLEDGE_README, report);
    ensureDir(join(project.jarvisDir, "standards"), report);
    ensureFile(join(project.jarvisDir, "standards", "README.md"), STANDARDS_README, report);
    ensureDir(join(project.jarvisDir, "skills"), report);
    ensureFile(join(project.jarvisDir, "skills", "README.md"), SKILLS_README, report);
    ensureDir(project.specsDir, report);
    ensureDir(project.approvalsDir, report);
    for (const dir of [project.specsDir, project.approvalsDir]) {
      ensureFile(join(dir, ".gitkeep"), "", report);
    }
    const gitignore = join(project.root, ".gitignore");
    if (existsSync(gitignore)) {
      const current = readFileSync(gitignore, "utf8");
      const missing = GITIGNORE_ENTRIES.filter(
        (e) => !e.startsWith("#") && !current.split(/\r?\n/).includes(e),
      );
      if (missing.length > 0) {
        const block = `${current.endsWith("\n") || current === "" ? "" : "\n"}${GITIGNORE_ENTRIES.join("\n")}\n`;
        appendFileSync(gitignore, block);
        created.push(`${gitignore} (+${missing.length} entries)`);
      } else {
        skipped.push(gitignore);
      }
    } else if (project.isGitRepo) {
      writeFileSync(gitignore, `${GITIGNORE_ENTRIES.join("\n")}\n`);
      created.push(gitignore);
    }
  }

  const base = { created, skipped, home: home.root, ...(service ? { service } : {}) };
  const withProject = projectRoot ? { ...base, project: projectRoot } : base;
  return schemaVersion === undefined ? withProject : { ...withProject, schemaVersion };
}

export function renderInit(ctx: CliContext, report: InitReport): void {
  const { out } = ctx;
  const show = (p: string) => (p.startsWith(ctx.cwd) ? relative(ctx.cwd, p) || "." : p);
  out.line(`jarvis home: ${report.home}`);
  if (report.project) out.line(`project:     ${report.project}`);
  if (report.service)
    out.line(
      `service:     ${report.service.name} of ${report.service.knowledgeRepo} — its configuration and knowledge are there, nothing is created here`,
    );
  if (report.schemaVersion !== undefined) out.line(`database:    schema v${report.schemaVersion}`);
  if (report.created.length > 0) {
    out.line();
    out.line("created:");
    for (const p of report.created) out.line(`  + ${show(p)}`);
  }
  if (report.skipped.length > 0) {
    out.line();
    out.line("already present:");
    for (const p of report.skipped) out.line(`  = ${show(p)}`);
  }
  out.line();
  out.line("next: edit the files above, then run `jarvis doctor`.");
}
