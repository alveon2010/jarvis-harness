import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { layoutOf } from "../core/paths.ts";
import { git } from "../tools/local/exec.ts";

/**
 * The project's configuration and knowledge a run starts with, as an eval case needs them later.
 * The working copy changes after the run (a module accepted, `project.yaml` edited, a commit
 * amended), so the case cannot take them from there: at the start the files that the base commit
 * does not hold as they are go into the repository's object store (`git hash-object -w`) and their
 * ids into the `run.created` event. Pilot: a module document accepted half an hour after a run
 * landed in that run's eval case.
 */
export type RunInputs = Readonly<Record<string, string>>;

/** `.jarvis/project.yaml` and `.jarvis/knowledge/**` of the working copy that differ from `base` or are not in it. */
export async function overlayFiles(repoRoot: string, base: string): Promise<string[]> {
  const files: string[] = [];
  const walk = (rel: string) => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
    else files.push(rel);
  };
  walk(".jarvis/project.yaml");
  walk(".jarvis/knowledge");
  const out: string[] = [];
  for (const rel of files) {
    const atBase = await git(["show", `${base}:${rel}`], repoRoot, { maxBytes: 16 * 1024 * 1024 });
    if (atBase.code !== 0 || atBase.stdout !== readFileSync(join(repoRoot, rel), "utf8")) out.push(rel);
  }
  return out;
}

/** Keeps the run's inputs that differ from `base` in the object store: path → blob id. Never throws. */
export async function recordInputs(repoRoot: string, base: string | undefined): Promise<RunInputs> {
  try {
    const commit = base ?? (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
    if (!commit) return {};
    const out: Record<string, string> = {};
    for (const rel of await overlayFiles(repoRoot, commit)) {
      const r = await git(["hash-object", "-w", "--", rel], repoRoot);
      if (r.code === 0 && r.stdout.trim()) out[rel] = r.stdout.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** The inputs a run recorded at its start (undefined for a run from before they were recorded). */
export function recordedInputs(payload: Record<string, unknown> | undefined): RunInputs | undefined {
  const inputs = payload?.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
  return Object.fromEntries(
    Object.entries(inputs as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && /^[0-9a-f]{40,64}$/.test(e[1]),
    ),
  );
}

/** A knowledge repository's part of a run's inputs (ADR-0025 §5): its commit and what differs from it. */
export interface KnowledgeRepoInputs {
  readonly root: string;
  readonly commit: string;
  readonly service?: string;
  /** Path in the knowledge repository → blob id, for its files the commit does not hold as they are. */
  readonly files: RunInputs;
}

/** What a knowledge repository with its files at the top keeps of Jarvis's besides `knowledge/`. */
const META_TOP_LEVEL = ["project.yaml", "workflows", "standards", "skills", "agents"];

/**
 * For a service of a knowledge repository: the knowledge repository's commit, and its configuration
 * and knowledge files that differ from it, kept in its object store. Undefined for a repository with
 * its own `.jarvis` or when git fails.
 */
export async function recordKnowledgeRepoInputs(repoRoot: string): Promise<KnowledgeRepoInputs | undefined> {
  const layout = layoutOf(repoRoot);
  const meta = layout.meta;
  if (!meta) return undefined;
  try {
    const commit = (await git(["rev-parse", "HEAD"], meta.root)).stdout.trim();
    if (!commit) return undefined;
    const rel = (abs: string) => relative(meta.root, abs).split(sep).join("/");
    // its own files: `.jarvis/`, or at the top of the repository the configuration and its folders
    const own =
      layout.jarvisDir === meta.root
        ? META_TOP_LEVEL.filter((p) => existsSync(join(meta.root, p)))
        : [rel(layout.jarvisDir)];
    const paths = [...own, rel(layout.knowledgeDir), ...(meta.service ? [rel(layout.glossaryFile)] : [])];
    const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ...paths], meta.root);
    const files: Record<string, string> = {};
    for (const line of status.stdout.split("\n").filter((l) => l.length > 3)) {
      const path = line.slice(3).replace(/^"|"$/g, "");
      // shared documents at the top of knowledge/ too; other services' folders are not this run's
      if (!existsSync(join(meta.root, path)) || statSync(join(meta.root, path)).isDirectory()) continue;
      const r = await git(["hash-object", "-w", "--", path], meta.root);
      if (r.code === 0 && r.stdout.trim()) files[path] = r.stdout.trim();
    }
    // the shared documents next to the services' folders
    if (meta.service) {
      const top = await git(
        ["status", "--porcelain", "--untracked-files=all", "--", ":(glob)knowledge/*.md"],
        meta.root,
      );
      for (const line of top.stdout.split("\n").filter((l) => l.length > 3)) {
        const path = line.slice(3).replace(/^"|"$/g, "");
        if (files[path] || !existsSync(join(meta.root, path))) continue;
        const r = await git(["hash-object", "-w", "--", path], meta.root);
        if (r.code === 0 && r.stdout.trim()) files[path] = r.stdout.trim();
      }
    }
    return { root: meta.root, commit, ...(meta.service ? { service: meta.service } : {}), files };
  } catch {
    return undefined;
  }
}
