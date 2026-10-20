import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createRuntime } from "../../app/runtime.ts";
import { dismissEvalCandidate, evalCandidates, isDismissed, reasonLine } from "../../evals/candidates.ts";
import { diffResults, runSuite, type SuiteResult } from "../../evals/runner.ts";
import { casesRootOf, runToCase } from "../../evals/runToCase.ts";
import { scheduleState, schedulesOf } from "../../evals/schedule.ts";
import type { CassetteMode } from "../../models/cassette.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

/** `jarvis evals run|baseline|diff` (ADR-0012 §4–5). Suites live in `evals/<suite>/<case>/`. */
export interface EvalsRunOptions {
  readonly suite: string;
  readonly mode?: string;
  readonly variant?: string[];
  readonly out?: string;
}

function parseVariant(items: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new CliExit(EXIT.error, `--variant expects key=value, got "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

function resultsDir(ctx: CliContext): string {
  return join(ctx.cwd, "evals", "results");
}

function renderSuite(ctx: CliContext, r: SuiteResult): void {
  ctx.out.line(
    `suite ${r.suite} (${r.mode}${
      Object.keys(r.variant).length > 0
        ? `, ${Object.entries(r.variant)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}`
        : ""
    })`,
  );
  const w = Math.max(...r.cases.map((c) => c.id.length), 4);
  ctx.out.line(
    `${padEnd("case", w)}  ${padEnd("state", 14)}  ok   tests  files  accept  answers  loops  out-tokens  /10k`,
  );
  for (const c of r.cases) {
    const pct = (x: number | undefined) =>
      x === undefined ? "  -  " : `${String(Math.round(x * 100)).padStart(3)}% `;
    ctx.out.line(
      `${padEnd(c.id, w)}  ${padEnd(c.state, 14)}  ${c.success ? "yes" : "no "}  ${c.testsPassed === undefined ? " -  " : c.testsPassed ? "pass" : "FAIL"}   ${pct(c.fileRecall)}  ${pct(c.acceptanceCoverage)}  ${pct(c.answersCoverage)}   ${String(c.loops).padStart(5)}  ${String(c.outputTokens).padStart(10)}  ${c.successPer10k}`,
    );
    if (c.error) ctx.out.line(`${" ".repeat(w)}  ${c.error.slice(0, 160)}`);
  }
  const s = r.summary;
  ctx.out.line(
    `summary: ${s.successes}/${s.cases} succeeded (${Math.round(s.successRate * 100)}%), file recall ${Math.round(s.meanFileRecall * 100)}%, acceptance ${Math.round(s.meanAcceptanceCoverage * 100)}%${s.meanAnswersCoverage !== undefined ? `, answers ${Math.round(s.meanAnswersCoverage * 100)}%` : ""}, ${s.outputTokens} output tokens → ${s.successPer10k} successes per 10k`,
  );
}

export async function runEvalsRun(ctx: CliContext, options: EvalsRunOptions): Promise<void> {
  const mode = (options.mode ?? "replay") as CassetteMode;
  if (!["live", "record", "replay"].includes(mode))
    throw new CliExit(EXIT.error, `--mode must be live, record or replay`);
  // a suite by name in a service: the knowledge repository's evals/ (ADR-0025 §5)
  const base = options.suite.includes("/") ? ctx.cwd : ((await loadForCli(ctx)).meta?.root ?? ctx.cwd);
  const suiteDir = resolve(base, options.suite.includes("/") ? options.suite : join("evals", options.suite));
  const result = await runSuite(suiteDir, {
    homeDir: ctx.homeDir,
    env: ctx.env,
    mode,
    variant: parseVariant(options.variant),
  });
  const file = options.out
    ? resolve(ctx.cwd, options.out)
    : join(resultsDir(ctx), `${result.at.slice(0, 10)}-${result.suite}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  ctx.out.result({ ...result, file }, () => {
    renderSuite(ctx, result);
    ctx.out.line(`written to ${file}`);
  });
  if (result.summary.successes < result.summary.cases) throw new CliExit(EXIT.error);
}

function baselineFile(ctx: CliContext, suite: string): string {
  return join(ctx.cwd, "evals", "baseline", `${basename(suite)}.json`);
}

function latestResult(ctx: CliContext, suite: string): SuiteResult | undefined {
  const dir = resultsDir(ctx);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(`-${basename(suite)}.json`))
    .sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(join(dir, last), "utf8")) as SuiteResult) : undefined;
}

export async function runEvalsBaseline(
  ctx: CliContext,
  suite: string,
  options: { from?: string },
): Promise<void> {
  const result = options.from
    ? (JSON.parse(readFileSync(resolve(ctx.cwd, options.from), "utf8")) as SuiteResult)
    : latestResult(ctx, suite);
  if (!result)
    throw new CliExit(
      EXIT.error,
      `no result for suite ${suite}; run \`jarvis evals run --suite ${suite}\` first`,
    );
  const file = baselineFile(ctx, suite);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  ctx.out.result({ baseline: file, at: result.at, summary: result.summary }, () =>
    ctx.out.line(`baseline for ${suite} ← ${result.at} (${file})`),
  );
}

export async function runEvalsDiff(
  ctx: CliContext,
  suite: string,
  options: { tolerance?: number; from?: string },
): Promise<void> {
  const file = baselineFile(ctx, suite);
  if (!existsSync(file))
    throw new CliExit(EXIT.error, `no baseline for ${suite}; run \`jarvis evals baseline ${suite}\``);
  const baseline = JSON.parse(readFileSync(file, "utf8")) as SuiteResult;
  const current = options.from
    ? (JSON.parse(readFileSync(resolve(ctx.cwd, options.from), "utf8")) as SuiteResult)
    : latestResult(ctx, suite);
  if (!current) throw new CliExit(EXIT.error, `no result for ${suite}`);
  const diff = diffResults(baseline, current, options.tolerance ?? 0.05);
  ctx.out.result({ baseline: baseline.at, current: current.at, ...diff }, () => {
    ctx.out.line(`baseline ${baseline.at} vs ${current.at}`);
    for (const [m, d] of Object.entries(diff.deltas))
      ctx.out.line(`  ${padEnd(m, 24)} ${d >= 0 ? "+" : ""}${d}`);
    ctx.out.line(diff.ok ? "no regression beyond tolerance" : `REGRESSION: ${diff.regressions.join("; ")}`);
  });
  if (!diff.ok) throw new CliExit(EXIT.error);
}

/** `jarvis evals run-to-case <run> --suite <name> [--id] [--no-fixture]` (ADR-0012 §3). */
export async function runEvalsRunToCase(
  ctx: CliContext,
  ref: string,
  options: { suite: string; id?: string; fixture?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = runtime.runs.resolve(ref);
    if (!run) throw new CliExit(EXIT.error, `run "${ref}" not found`);
    const suiteDir = resolve(
      options.suite.includes("/") ? ctx.cwd : casesRootOf(run.workspace.repoRoot),
      options.suite.includes("/") ? options.suite : join("evals", options.suite),
    );
    const result = await runToCase(runtime, run.id, {
      suiteDir,
      ...(options.id ? { id: options.id } : {}),
      ...(options.fixture === false ? { fixture: false } : {}),
    });
    ctx.out.result(result, () => {
      ctx.out.line(`case written to ${result.caseDir}${result.fixture ? " (with fixture)" : ""}`);
      ctx.out.line(`  gold files: ${result.files.join(", ") || "-"}`);
      ctx.out.line(
        `  acceptance: ${result.acceptance.length}; required sources: ${result.requiredSources.length}${result.humanVersions.length > 0 ? ` (from human versions ${result.humanVersions.join(", ")})` : " (no human-edited artifacts: review the gold by hand)"}`,
      );
      if (result.skipped)
        ctx.out.line(`  not in the overlay (changed after the run began): ${result.skipped.join(", ")}`);
      if (result.userSkills)
        ctx.out.line(
          `  warning: the run used your own skills, the case does not hold them: ${result.userSkills.join(", ")} — move them into the project's .agents/skills to keep the case reproducible`,
        );
      ctx.out.line("  next: review case.yaml, then `jarvis evals run --mode record`");
    });
  } finally {
    await runtime.close();
  }
}

/**
 * `jarvis evals candidates [--dismiss <run>]` (ADR-0012 §3): the finished runs Jarvis learned something on,
 * noted at their end (src/evals/candidates.ts), with why; `--dismiss` takes one off the list.
 */
export async function runEvalsCandidates(ctx: CliContext, options: { dismiss?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    if (options.dismiss) {
      const run = runtime.runs.resolve(options.dismiss);
      if (!run) throw new CliExit(EXIT.error, `run "${options.dismiss}" not found`);
      if (!isDismissed(runtime, run.id))
        dismissEvalCandidate(runtime, run.id, loaded.config.actor.id ?? "cli");
      ctx.out.result({ dismissed: run.id }, () =>
        ctx.out.line(`${shortRunId(run.id)} is off the list of eval case candidates`),
      );
      return;
    }
    const list = evalCandidates(runtime);
    ctx.out.result({ candidates: list }, () => {
      if (list.length === 0) {
        ctx.out.line(
          "no eval case candidates: a run lands here when it ends accepted and a person corrected it on the way",
        );
        return;
      }
      for (const c of list) {
        ctx.out.line(`${shortRunId(c.runId)}  ${c.workflow}  ${c.task.split("\n")[0]?.slice(0, 80)}`);
        ctx.out.line(`  why: ${c.reasons.map(reasonLine).join("; ")}`);
      }
      ctx.out.line(
        "make one: `jarvis evals run-to-case <run>`; not a case: `jarvis evals candidates --dismiss <run>`",
      );
    });
  } finally {
    await runtime.close();
  }
}

/** `jarvis evals schedule` (ADR-0012 §5): the scheduled suites, their last run and when they run next. */
export async function runEvalsSchedule(ctx: CliContext): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const now = new Date();
    const states = schedulesOf(runtime).map((s) => scheduleState(runtime, s, now));
    ctx.out.result(
      {
        schedules: states.map((st) => ({
          ...st.schedule,
          ...(st.last ? { last: st.last } : {}),
          ...(st.running ? { running: st.running } : {}),
          ...(st.next ? { next: st.next.toISOString() } : {}),
        })),
      },
      () => {
        if (states.length === 0) {
          ctx.out.line("no scheduled evals: add evals.schedule to the configuration (docs/evals.md)");
          return;
        }
        for (const st of states) {
          const s = st.schedule;
          ctx.out.line(
            `${s.suite}  ${s.every ? `every ${s.every}` : `cron "${s.cron}"`}  ${s.mode}  pool ${s.pool}`,
          );
          const last = st.last;
          ctx.out.line(
            `  last: ${
              last
                ? `${last.at} ${last.error ? `failed: ${last.error}` : last.regressed ? `REGRESSION: ${last.regressions.join("; ")}` : `${last.summary?.successes}/${last.summary?.cases} succeeded${last.baseline ? ", no regression" : ", no baseline yet"}`}`
                : "never"
            }`,
          );
          ctx.out.line(
            `  next: ${st.running ? `running since ${st.running}` : st.next ? (st.next.getTime() <= now.getTime() ? "due now (the daemon runs it on its next tick)" : st.next.toISOString()) : "never (the cron names no minute within a year)"}`,
          );
        }
      },
    );
  } finally {
    await runtime.close();
  }
}
