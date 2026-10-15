import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
