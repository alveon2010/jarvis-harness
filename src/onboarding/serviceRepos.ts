import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { knowledgeConfigOf } from "../core/config/meta.ts";
import { ServiceNameSchema } from "../core/config/schema.ts";
import { PROJECT_CONFIG, PROJECT_DIR } from "../core/paths.ts";

/**
 * The git repositories next to a knowledge repository that could be its services (ADR-0025 §2):
 * for `jarvis init --knowledge`, which drafts the map from them, and for the Services page, which
 * names the ones not in the map yet.
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

export const STACKS: ReadonlyArray<readonly [string, string]> = [
  ["build.gradle.kts", "gradle"],
  ["build.gradle", "gradle"],
  ["pom.xml", "maven"],
  ["package.json", "node"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
];

export const stackOf = (dir: string): string | undefined =>
  STACKS.find(([f]) => existsSync(join(dir, f)))?.[1];

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
