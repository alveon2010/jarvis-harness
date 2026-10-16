import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { createEngine } from "../app/engine.ts";
import { createRuntime, type Runtime } from "../app/runtime.ts";
import { loadConfig } from "../core/config/load.ts";
import { serviceRepos } from "../core/config/meta.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { CassetteMode } from "../models/cassette.ts";
import { leaseOwner } from "../orchestration/lease.ts";
import { git, runShell } from "../tools/local/exec.ts";

/**
 * Evals runner (ADR-0012): workflow-tier cases on fixture repositories, scored deterministically
 * first (tests, file recall, acceptance coverage, loops, tokens), replayed from cassettes in CI
 * and recorded on demand. The top-level metric is task success per 10k output tokens.
 */
export const CaseSchema = z.strictObject({
  id: z.string().min(1).optional(),
  task: z.string().min(1),
  workflow: z.string().min(1).default("sdd"),
  /**
   * The repository the case starts from: a directory relative to the case directory (a copy), or
   * `{ commit }` — the repository the case lives in, at that commit (no copy: a service's repository is
   * megabytes), with the case's `overlay/` directory (the run's `.jarvis/` configuration and knowledge)
   * laid over it.
   */
  fixture: z
    .union([
      z.string().min(1),
      /**
       * A service of a knowledge repository (ADR-0025 §5): its repository at `commit` (where this
       * machine's map has it), and the knowledge repository the case lives in at `knowledge.commit`
       * with the run's changed files in `knowledge.overlay/` — laid out side by side as the map says.
       */
      z.strictObject({
        service: z.string().min(1),
        commit: z.string().min(1),
        knowledge: z.strictObject({
          commit: z.string().min(1),
          overlay: z.string().min(1).default("overlay"),
        }),
      }),
      z.strictObject({ commit: z.string().min(1), overlay: z.string().min(1).default("overlay") }),
    ])
    .default("fixture"),
  /** Written as the fixture's `.jarvis/project.yaml` (merged over the fixture's own if any). */
  project: z.record(z.string(), z.unknown()).optional(),
  gold: z
    .strictObject({
      files: z.array(z.string()).default([]).describe("files the change must touch"),
      tests: z.string().min(1).optional().describe("command that must pass in the workspace afterwards"),
      acceptance: z
        .array(z.string())
        .default([])
        .describe("phrases the spec's acceptance criteria must contain"),
      requiredSources: z.array(z.string()).default([]).describe("sources the research/impact must cite"),
      /** What a person answered at the gates (`run-to-case`): kept for review, not scored yet. */
      answers: z.array(z.strictObject({ question: z.string(), answer: z.string() })).default([]),
    })
    .prefault({}),
  /** Cassette directory relative to the case directory. */
  cassette: z.string().min(1).default("cassette"),
  maxApprovals: z.int().positive().default(6),
  /** Where a derived case came from (`jarvis evals run-to-case`, ADR-0012 §3). */
  source: z.record(z.string(), z.unknown()).optional(),
});
export type EvalCase = z.infer<typeof CaseSchema> & { readonly dir: string; readonly id: string };

export interface CaseScore {
  readonly id: string;
  readonly state: string;
  readonly success: boolean;
  readonly testsPassed?: boolean;
  readonly fileRecall?: number;
  readonly acceptanceCoverage?: number;
  readonly sourceRecall?: number;
  readonly loops: number;
  readonly outputTokens: number;
  readonly promptTokens: number;
  readonly modelCalls: number;
  /** success / (outputTokens / 10k) — the ADR-0012 §2 headline. */
  readonly successPer10k: number;
  readonly changedFiles: string[];
  readonly error?: string;
  readonly ms: number;
}

export interface SuiteResult {
  readonly suite: string;
  readonly mode: CassetteMode;
  readonly variant: Record<string, string>;
  readonly at: string;
  readonly cases: CaseScore[];
  readonly summary: {
    readonly cases: number;
    readonly successes: number;
    readonly successRate: number;
    readonly meanFileRecall: number;
    readonly meanAcceptanceCoverage: number;
    readonly outputTokens: number;
    readonly successPer10k: number;
  };
}

export function loadSuite(suiteDir: string): EvalCase[] {
  if (!existsSync(suiteDir)) throw new Error(`suite directory ${suiteDir} does not exist`);
  return readdirSync(suiteDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(suiteDir, d.name, "case.yaml")))
    .map((d) => {
      const dir = join(suiteDir, d.name);
      const raw: unknown = parse(readFileSync(join(dir, "case.yaml"), "utf8"));
      const parsed = CaseSchema.safeParse(raw ?? {});
      if (!parsed.success)
        throw new Error(
          `${dir}/case.yaml: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      return { ...parsed.data, dir, id: parsed.data.id ?? d.name };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface RunCaseOptions {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly mode: CassetteMode;
  readonly variant?: Record<string, string>;
  readonly actor?: Actor;
}

const EVAL_ACTOR: Actor = { kind: "user", id: "evals@jarvis", verified: false };

function setDeep(target: Record<string, unknown>, path: string, value: string): void {
  const keys = path.split(".");
  let cur = target;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!next || typeof next !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] as string;
  cur[last] =
    value === "true"
      ? true
      : value === "false"
        ? false
        : /^-?\d+(\.\d+)?$/.test(value)
          ? Number(value)
          : value;
}

/** Copies the fixture into a throwaway git repository with the case's project config. */
/** `git archive <commit>` of the repository at `from` into `to`. */
async function archive(c: EvalCase, from: string, commit: string, to: string): Promise<void> {
  mkdirSync(to, { recursive: true });
  const r = await runShell(`git archive --format=tar ${commit} | tar -x -C "${to}"`, {
    cwd: from,
    timeoutMs: 300_000,
  });
  if (r.code !== 0)
    throw new Error(`case ${c.id}: git archive ${commit} in ${from} failed: ${r.stderr.trim()}`);
}

async function commitAll(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "evals",
    GIT_AUTHOR_EMAIL: "evals@jarvis",
    GIT_COMMITTER_NAME: "evals",
    GIT_COMMITTER_EMAIL: "evals@jarvis",
  };
  if (existsSync(join(dir, ".git"))) return;
  await git(["init", "-q", "-b", "main"], dir, { env: gitEnv });
  await git(["add", "-A"], dir, { env: gitEnv });
  await git(["commit", "-q", "-m", "fixture"], dir, { env: gitEnv });
}

/**
 * A service's case (ADR-0025 §5): the knowledge repository (where the case lives) at its commit with
 * the overlay, the service's repository at its commit next to it, the map pointing at that folder; the
 * case's `project` and the variant go to the service's entry. Returns the service's folder.
 */
async function prepareServiceWorkspace(
  c: EvalCase & {
    fixture: { service: string; commit: string; knowledge: { commit: string; overlay: string } };
  },
  variant: Record<string, string>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<{ root: string; sandbox: string; knowledgeRepo: string }> {
  const f = c.fixture;
  const top = await git(["rev-parse", "--show-toplevel"], c.dir);
  if (top.code !== 0)
    throw new Error(`case ${c.id}: ${c.dir} is in no git repository (the knowledge repository)`);
  const metaTop = top.stdout.trim();
  const metaConfig =
    (parse(readFileSync(join(metaTop, ".jarvis", "project.yaml"), "utf8")) as Record<string, unknown>) ?? {};
  // where this machine has the service's repository: the personal map, then the knowledge repository's
  let userRepos: Record<string, string> | undefined;
  try {
    const user = parse(readFileSync(join(homeDir, ".jarvis", "config.yaml"), "utf8")) as {
      repos?: Record<string, string>;
    };
    userRepos = user?.repos;
  } catch {
    userRepos = undefined;
  }
  const from = serviceRepos(metaTop, metaConfig, userRepos, homeDir)[f.service];
  if (!from || !existsSync(from))
    throw new Error(`case ${c.id}: no repository of ${f.service} on this machine`);
  const sandbox = mkdtempSync(join(tmpdir(), `jarvis-eval-${c.id.slice(0, 40)}-`));
  const knowledgeRepo = join(sandbox, basename(metaTop));
  await archive(c, metaTop, f.knowledge.commit, knowledgeRepo);
  const overlay = join(c.dir, f.knowledge.overlay);
  if (existsSync(overlay)) cpSync(overlay, knowledgeRepo, { recursive: true });
  const file = join(knowledgeRepo, ".jarvis", "project.yaml");
  const project = (parse(readFileSync(file, "utf8")) as Record<string, unknown>) ?? { version: 1 };
  const services = { ...((project.services as Record<string, Record<string, unknown>>) ?? {}) };
  const entry: Record<string, unknown> = {
    ...(services[f.service] ?? {}),
    ...(c.project ?? {}),
    repo: f.service,
  };
  for (const [k, v] of Object.entries(variant)) setDeep(entry, k, v);
  services[f.service] = entry;
  const { stringify } = await import("yaml");
  writeFileSync(file, stringify({ ...project, repos: "..", services }));
  const root = join(sandbox, f.service);
  await archive(c, from, f.commit, root);
  await commitAll(knowledgeRepo, env);
  await commitAll(root, env);
  return { root, sandbox, knowledgeRepo };
}

async function prepareWorkspace(
  c: EvalCase,
  variant: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `jarvis-eval-${c.id.slice(0, 40)}-`));
  if (typeof c.fixture === "string") cpSync(join(c.dir, c.fixture), root, { recursive: true });
  else if ("service" in c.fixture)
    throw new Error(`case ${c.id}: a service's fixture is prepared on its own`);
  else {
    // the repository the case lives in, at the commit, and the run's .jarvis/ over it
    const top = await git(["rev-parse", "--show-toplevel"], c.dir);
    if (top.code !== 0)
      throw new Error(`case ${c.id}: its fixture is a commit, and ${c.dir} is in no git repository`);
    const archive = await runShell(`git archive --format=tar ${c.fixture.commit} | tar -x -C "${root}"`, {
      cwd: top.stdout.trim(),
      timeoutMs: 300_000,
    });
    if (archive.code !== 0)
      throw new Error(`case ${c.id}: git archive ${c.fixture.commit} failed: ${archive.stderr.trim()}`);
    const overlay = join(c.dir, c.fixture.overlay);
    if (existsSync(overlay)) cpSync(overlay, root, { recursive: true });
  }
  const projectFile = join(root, ".jarvis", "project.yaml");
  const base: Record<string, unknown> = existsSync(projectFile)
    ? ((parse(readFileSync(projectFile, "utf8")) as Record<string, unknown>) ?? {})
    : { version: 1 };
  const project = { ...base, ...(c.project ?? {}) };
  for (const [k, v] of Object.entries(variant)) setDeep(project, k, v);
  mkdirSync(join(root, ".jarvis"), { recursive: true });
  const { stringify } = await import("yaml");
  writeFileSync(projectFile, stringify(project));
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "evals",
    GIT_AUTHOR_EMAIL: "evals@jarvis",
    GIT_COMMITTER_NAME: "evals",
    GIT_COMMITTER_EMAIL: "evals@jarvis",
  };
  if (!existsSync(join(root, ".git"))) {
    await git(["init", "-q", "-b", "main"], root, { env: gitEnv });
    await git(["add", "-A"], root, { env: gitEnv });
    await git(["commit", "-q", "-m", "fixture"], root, { env: gitEnv });
  }
  return root;
}

export async function runCase(c: EvalCase, options: RunCaseOptions): Promise<CaseScore> {
  const started = Date.now();
  const variant = options.variant ?? {};
  const env = { ...options.env, JARVIS_ACTOR: EVAL_ACTOR.id };
  // a service of a knowledge repository: both repositories side by side in a sandbox (ADR-0025 §5)
  const service =
    typeof c.fixture === "object" && "service" in c.fixture
      ? await prepareServiceWorkspace(
          c as Parameters<typeof prepareServiceWorkspace>[0],
          variant,
          env,
          options.homeDir,
        )
      : undefined;
  const root = service ? service.root : await prepareWorkspace(c, variant, env);
  const loadEnv = service ? { ...env, JARVIS_KNOWLEDGE: service.knowledgeRepo } : env;
  let runtime: Runtime | undefined;
  try {
    const loaded = await loadConfig({
      cwd: root,
      homeDir: options.homeDir,
      env: loadEnv,
      ...(service ? { ignoreUserRepos: true } : {}),
    });
    if (service && loaded.meta?.service !== (c.fixture as { service: string }).service)
      throw new Error(`case ${c.id}: the sandbox's knowledge repository does not map ${root} to its service`);
    runtime = createRuntime(loaded, { env, cassette: { mode: options.mode, dir: join(c.dir, c.cassette) } });
    const engine = createEngine(runtime);
    engine.workflow(c.workflow);
    const run = runtime.runs.create({
      task: c.task,
      workflow: c.workflow,
      owner: options.actor ?? EVAL_ACTOR,
      workspace: { mode: "cwd", repoRoot: root, path: root, baseRef: "HEAD" },
      dataClass: loaded.config.dataClass,
    });
    const owner = leaseOwner("cli");
    let result = await engine.execute(run.id, { owner, steal: false });
    // Evals have no human: every gate is approved, up to maxApprovals; clarifications end the case.
    let approvals = 0;
    while (
      result.run.state === "WAITING_HUMAN" &&
      result.run.waitingFor?.kind === "approval" &&
      approvals < c.maxApprovals
    ) {
      const type = result.run.waitingFor.detail as string;
      const latest = runtime.artifacts.listLatest(run.id, type)[0];
      if (!latest) break;
      runtime.artifacts.approve({
        runId: run.id,
        stepId: result.run.currentStep ?? "approve",
        artifactId: latest.artifactId,
        version: latest.version,
        actor: EVAL_ACTOR,
        decision: "approve",
      });
      approvals += 1;
      result = await engine.execute(run.id, { owner, steal: false });
    }
    const final = result.run;
    const events = runtime.events.list({ runId: run.id, limit: 10000 });
    const tokens = events
      .filter((e) => e.kind === "model.call")
      .reduce(
        (acc, e) => {
          const p = (e.payload ?? {}) as Record<string, number>;
          return {
            calls: acc.calls + 1,
            out: acc.out + (p.outputTokens ?? 0),
            prompt: acc.prompt + (p.promptTokens ?? 0),
          };
        },
        { calls: 0, out: 0, prompt: 0 },
      );
    const loops = Object.values(final.iterations).reduce((a, b) => a + b, 0);

    const diff = await git(["diff", "--name-only", "HEAD"], root);
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], root);
    const changed = [...new Set([...(diff.stdout + untracked.stdout).split("\n").filter(Boolean)])]
      .filter((f) => !f.startsWith(".jarvis/"))
      .sort();

    let testsPassed: boolean | undefined;
    if (c.gold.tests) {
      const r = await runShell(c.gold.tests, { cwd: root, timeoutMs: 600_000, env });
      testsPassed = r.code === 0;
    }
    const fileRecall =
      c.gold.files.length > 0
        ? c.gold.files.filter((f) => changed.includes(f)).length / c.gold.files.length
        : undefined;
    const specText = (() => {
      const spec = runtime?.artifacts.listLatest(run.id, "spec")[0];
      return spec && runtime ? runtime.artifacts.text(spec).toLowerCase() : "";
    })();
    const acceptanceCoverage =
      c.gold.acceptance.length > 0
        ? c.gold.acceptance.filter((a) => specText.includes(a.toLowerCase())).length /
          c.gold.acceptance.length
        : undefined;
    const cited = new Set(runtime.artifacts.listLatest(run.id).flatMap((a) => a.sourceRefs));
    const sourceRecall =
      c.gold.requiredSources.length > 0
        ? c.gold.requiredSources.filter((s) => [...cited].some((x) => x.includes(s))).length /
          c.gold.requiredSources.length
        : undefined;

    const success =
      final.state === "COMPLETED" &&
      (testsPassed ?? true) &&
      (fileRecall === undefined || fileRecall === 1) &&
      (acceptanceCoverage === undefined || acceptanceCoverage === 1) &&
      (sourceRecall === undefined || sourceRecall === 1);
    const successPer10k =
      tokens.out > 0 ? (success ? 1 : 0) / (tokens.out / 10_000) : success ? Number.POSITIVE_INFINITY : 0;
    return {
      id: c.id,
      state: final.state,
      success,
      ...(testsPassed !== undefined ? { testsPassed } : {}),
      ...(fileRecall !== undefined ? { fileRecall } : {}),
      ...(acceptanceCoverage !== undefined ? { acceptanceCoverage } : {}),
      ...(sourceRecall !== undefined ? { sourceRecall } : {}),
      loops,
      outputTokens: tokens.out,
      promptTokens: tokens.prompt,
      modelCalls: tokens.calls,
      successPer10k: Number.isFinite(successPer10k) ? Number(successPer10k.toFixed(3)) : 0,
      changedFiles: changed,
      ...(final.stateReason && final.state !== "COMPLETED" ? { error: final.stateReason } : {}),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      id: c.id,
      state: "ERROR",
      success: false,
      loops: 0,
      outputTokens: 0,
      promptTokens: 0,
      modelCalls: 0,
      successPer10k: 0,
      changedFiles: [],
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  } finally {
    await runtime?.close();
    rmSync(service ? service.sandbox : root, { recursive: true, force: true });
  }
}

export async function runSuite(suiteDir: string, options: RunCaseOptions): Promise<SuiteResult> {
  const cases = loadSuite(suiteDir);
  const scores: CaseScore[] = [];
  for (const c of cases) scores.push(await runCase(c, options));
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const successes = scores.filter((s) => s.success).length;
  const outputTokens = scores.reduce((a, s) => a + s.outputTokens, 0);
  return {
    suite: basename(suiteDir),
    mode: options.mode,
    variant: options.variant ?? {},
    at: new Date().toISOString(),
    cases: scores,
    summary: {
      cases: scores.length,
      successes,
      successRate: scores.length > 0 ? successes / scores.length : 0,
      meanFileRecall: mean(scores.map((s) => s.fileRecall).filter((x): x is number => x !== undefined)),
      meanAcceptanceCoverage: mean(
        scores.map((s) => s.acceptanceCoverage).filter((x): x is number => x !== undefined),
      ),
      outputTokens,
      successPer10k: outputTokens > 0 ? Number((successes / (outputTokens / 10_000)).toFixed(3)) : 0,
    },
  };
}

/** ADR-0012 §5: regression beyond the tolerance on any headline metric fails `evals diff`. */
export function diffResults(
  baseline: SuiteResult,
  current: SuiteResult,
  tolerance = 0.05,
): { ok: boolean; regressions: string[]; deltas: Record<string, number> } {
  const metrics: Array<keyof SuiteResult["summary"]> = [
    "successRate",
    "meanFileRecall",
    "meanAcceptanceCoverage",
    "successPer10k",
  ];
  const regressions: string[] = [];
  const deltas: Record<string, number> = {};
  for (const m of metrics) {
    const before = baseline.summary[m];
    const after = current.summary[m];
    const delta = after - before;
    deltas[m] = Number(delta.toFixed(4));
    const allowed = Math.max(tolerance * Math.abs(before), tolerance);
    if (delta < -allowed) regressions.push(`${m}: ${before} → ${after}`);
  }
  return { ok: regressions.length === 0, regressions, deltas };
}
