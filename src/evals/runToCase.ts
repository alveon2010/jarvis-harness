import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { stringify } from "yaml";
import type { Runtime } from "../app/runtime.ts";
import { loadConfig } from "../core/config/load.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { layoutOf } from "../core/paths.ts";
import { givenFor } from "../interaction/answers.ts";
import { readableIdFor } from "../orchestration/worktree.ts";
import { git, runShell } from "../tools/local/exec.ts";
import { overlayFiles, recordedInputs } from "./inputs.ts";

/**
 * ADR-0012 §3: a finished run becomes an eval case — the task, the repository at the base commit as
 * fixture, gold from what the human accepted (changed files, acceptance criteria, the sources the
 * human-edited artifacts cite). Secrets were redacted at write time (ADR-0010); the case still gets
 * a human look before it joins a suite, because it carries project context.
 */
export interface RunToCaseOptions {
  readonly suiteDir: string;
  readonly id?: string;
  /** Include the fixture (git archive of the base commit); off writes case.yaml only. */
  readonly fixture?: boolean;
}

export interface RunToCaseResult {
  readonly caseDir: string;
  readonly files: string[];
  readonly acceptance: string[];
  readonly requiredSources: string[];
  readonly humanVersions: string[];
  /** The open questions a person answered at the gates (src/interaction/answers.ts). */
  readonly answers: number;
  /**
   * Configuration and knowledge left out of the overlay: changed after the run began (a run from
   * before its inputs were recorded) or no longer in the object store — the case runs without them.
   */
  readonly skipped?: string[];
  readonly fixture: boolean;
}

/** The case a run already became, if any: `evals/<suite>/<id>/case.yaml` naming it as its source. */
export function caseOfRun(
  repoRoot: string,
  runId: string,
): { readonly dir: string; readonly suite: string } | undefined {
  const evals = join(repoRoot, "evals");
  if (!existsSync(evals)) return undefined;
  for (const suite of readdirSync(evals, { withFileTypes: true })) {
    if (!suite.isDirectory()) continue;
    for (const c of readdirSync(join(evals, suite.name), { withFileTypes: true })) {
      const file = join(evals, suite.name, c.name, "case.yaml");
      if (!c.isDirectory() || !existsSync(file)) continue;
      if (readFileSync(file, "utf8").includes(runId))
        return { dir: join("evals", suite.name, c.name), suite: suite.name };
    }
  }
  return undefined;
}

/** The newest human-edited version of an artifact type, else the latest agent version. */
function preferred(runtime: Runtime, runId: string, type: string): ArtifactVersion | undefined {
  const latest = runtime.artifacts.listLatest(runId, type)[0];
  if (!latest) return undefined;
  const versions = runtime.artifacts.versions(latest.artifactId);
  return [...versions].reverse().find((v) => v.provenance.kind === "human") ?? latest;
}

/** Where a run's eval cases live: its repository's `evals/`, or for a service the knowledge repository's (ADR-0025 §5). */
export function casesRootOf(repoRoot: string): string {
  const meta = layoutOf(repoRoot).meta;
  return meta?.service ? meta.root : repoRoot;
}

export async function runToCase(
  runtime: Runtime,
  runId: string,
  options: RunToCaseOptions,
): Promise<RunToCaseResult> {
  const run = runtime.runs.require(runId);
  // short and readable: the ticket key or the task's first words, and the run (pilot: a 230-character
  // directory name made of every Latin word of a Russian task)
  const id = options.id ?? readableIdFor(run.task, run.id);
  // a service of a knowledge repository: its cases live in the knowledge repository (ADR-0025 §5)
  const knowledgeRepo = layoutOf(run.workspace.repoRoot).meta;
  const service = knowledgeRepo?.service;
  if (knowledgeRepo && service) {
    const at = relative(knowledgeRepo.root, options.suiteDir);
    if (at.startsWith("..") || isAbsolute(at))
      throw new Error(
        `the cases of a service go to the knowledge repository's evals/ (${knowledgeRepo.root}): nothing is written into the service's repository`,
      );
  }
  const caseDir = join(options.suiteDir, id);
  if (existsSync(join(caseDir, "case.yaml"))) throw new Error(`case ${caseDir} already exists`);
  mkdirSync(caseDir, { recursive: true });

  const ws = run.workspace;
  // a commit, not a name that moves (`HEAD` of a run in the working copy): the case starts from it later
  const named = ws.baseCommit ?? ws.baseRef;
  const resolved = /^[0-9a-f]{40}$/.test(named)
    ? named
    : (await git(["rev-parse", named], ws.repoRoot)).stdout.trim();
  const base = resolved || named;
  // the run's own work: its checkout, or — removed — its branch in the repository (not what is checked out there)
  const inCheckout = existsSync(ws.path);
  const diffFrom = inCheckout ? ws.path : ws.repoRoot;
  const tip = inCheckout || !ws.branch ? "HEAD" : ws.branch;
  const diff = await git(["diff", "--name-only", `${base}..${tip}`], diffFrom);
  const working = inCheckout ? await git(["diff", "--name-only", "HEAD"], diffFrom) : { stdout: "" };
  const files = [
    ...new Set(`${diff.stdout}\n${working.stdout}`.split("\n").filter((f) => f && !f.startsWith(".jarvis/"))),
  ].sort();

  const spec = preferred(runtime, run.id, "spec");
  const impact = preferred(runtime, run.id, "impact");
  const research = preferred(runtime, run.id, "research");
  const humanVersions = [spec, impact, research]
    .filter((a): a is ArtifactVersion => a?.provenance.kind === "human")
    .map((a) => `${a.type}@${a.version}`);
  let acceptance: string[] = [];
  if (spec) {
    try {
      const doc = JSON.parse(runtime.artifacts.text(spec)) as {
        requirements?: Array<{ acceptance?: string[] }>;
      };
      acceptance = [...new Set((doc.requirements ?? []).flatMap((r) => r.acceptance ?? []))];
    } catch {
      // not JSON
    }
  }
  // Required evidence: the sources human-edited artifacts cite (ADR-0015 §6); agent-only ones are not gold.
  const requiredSources = [
    ...new Set(
      [spec, impact, research]
        .filter((a): a is ArtifactVersion => a?.provenance.kind === "human")
        .flatMap((a) => a.sourceRefs),
    ),
  ]
    .filter((s) => !/^(standard|skill|knowledge):/.test(s))
    .sort();

  // the service's own commands, when the case is made from the knowledge repository (services.<name>)
  const local = service
    ? (
        await loadConfig({
          cwd: ws.repoRoot,
          env: { ...process.env, JARVIS_HOME: runtime.loaded.home.root },
        })
      ).config.tools.local
    : runtime.loaded.config.tools.local;
  const tests = local.test ?? local.tests ?? local.check;
  // what a person answered to the documents' open questions: the decisions the next run must reach too
  const answers = [spec, impact, research]
    .filter((a): a is ArtifactVersion => a !== undefined)
    .flatMap((a) =>
      runtime.artifacts
        .versions(a.artifactId)
        .flatMap((v) => givenFor(runtime, v) ?? [])
        .filter((g) => g.mode === "answer" && g.text)
        .map((g) => ({ question: g.question, answer: g.text as string })),
    );
  // a suite inside the run's repository takes the repository at the base commit by reference: no copy
  const rel = relative(ws.repoRoot, options.suiteDir);
  const inRepo = !service && options.fixture !== false && !rel.startsWith("..") && !isAbsolute(rel);
  // the knowledge repository as the run started with it: its commit, and its changed files kept then
  const created = runtime.events.list({ runId: run.id, kind: "run.created", limit: 1 })[0];
  const kept = (created?.payload as { knowledgeRepo?: { commit?: unknown; files?: unknown } } | undefined)
    ?.knowledgeRepo;
  const knowledgeCommit =
    service && knowledgeRepo
      ? typeof kept?.commit === "string"
        ? kept.commit
        : (await git(["rev-parse", "HEAD"], knowledgeRepo.root)).stdout.trim()
      : undefined;
  const caseDoc = {
    id,
    task: run.task,
    workflow: run.workflow,
    fixture:
      service && knowledgeCommit
        ? { service, commit: base, knowledge: { commit: knowledgeCommit, overlay: "overlay" } }
        : inRepo
          ? { commit: base, overlay: "overlay" }
          : "fixture",
    gold: {
      files,
      ...(tests ? { tests } : {}),
      acceptance,
      requiredSources,
      ...(answers.length > 0 ? { answers } : {}),
    },
    cassette: "cassette",
    source: { run: run.id, baseCommit: base, exportedAt: new Date().toISOString(), humanVersions },
  };
  writeFileSync(join(caseDir, "case.yaml"), stringify(caseDoc));
  mkdirSync(join(caseDir, "cassette"), { recursive: true });
  writeFileSync(
    join(caseDir, "cassette", "README.md"),
    "Recorded by `jarvis evals run --mode record`; empty until then.\n",
  );

  let fixture = false;
  const skipped: string[] = [];
  if (service && knowledgeRepo) {
    // the knowledge repository's files the run had and its commit does not hold as they are
    const files =
      kept && typeof kept.files === "object" && kept.files !== null
        ? (kept.files as Record<string, unknown>)
        : undefined;
    if (files) {
      for (const [rel, blob] of Object.entries(files)) {
        const content =
          typeof blob === "string"
            ? await git(["cat-file", "blob", blob], knowledgeRepo.root, { maxBytes: 16 * 1024 * 1024 })
            : undefined;
        if (content?.code !== 0) {
          skipped.push(rel);
          continue;
        }
        const to = join(caseDir, "overlay", rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content.stdout);
      }
    }
    fixture = true;
  } else if (inRepo) {
    // the project's configuration and knowledge as the run had them: only what the base commit does not
    // already hold as it is — committed, the overlay stays empty. A run records them at its start
    // (src/evals/inputs.ts); for an older one the working copy's, but not what changed after it began.
    const created = runtime.events.list({ runId: run.id, kind: "run.created", limit: 1 })[0];
    const recorded = recordedInputs(created?.payload);
    if (recorded) {
      for (const [rel, blob] of Object.entries(recorded)) {
        const content = await git(["cat-file", "blob", blob], ws.repoRoot, { maxBytes: 16 * 1024 * 1024 });
        if (content.code !== 0) {
          skipped.push(rel);
          continue;
        }
        const to = join(caseDir, "overlay", rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content.stdout);
      }
    } else {
      const began = Date.parse(run.createdAt);
      for (const rel of await overlayFiles(ws.repoRoot, base)) {
        if (statSync(join(ws.repoRoot, rel)).mtimeMs > began) {
          skipped.push(rel);
          continue;
        }
        const to = join(caseDir, "overlay", rel);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(join(ws.repoRoot, rel), to);
      }
    }
    fixture = true;
  } else if (options.fixture !== false) {
    const fixtureDir = join(caseDir, "fixture");
    mkdirSync(fixtureDir, { recursive: true });
    const archive = await runShell(`git archive --format=tar ${base} | tar -x -C "${fixtureDir}"`, {
      cwd: ws.repoRoot,
      timeoutMs: 300_000,
    });
    if (archive.code !== 0) throw new Error(`git archive ${base} failed: ${archive.stderr.trim()}`);
    // the project's configuration and knowledge as the run had them, also when they are not committed
    for (const part of ["project.yaml", "knowledge"]) {
      const from = join(ws.repoRoot, ".jarvis", part);
      const to = join(fixtureDir, ".jarvis", part);
      if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
    }
    fixture = true;
  }
  return {
    caseDir,
    files,
    acceptance,
    requiredSources,
    humanVersions,
    answers: answers.length,
    fixture,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
