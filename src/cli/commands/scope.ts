import { crossContinuationOf, crossStartOf, goCross, goSingle, scopeOf } from "../../app/crossScope.ts";
import { createEngine } from "../../app/engine.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import type { Run } from "../../core/domain/run.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";
import { actorFor, executeAndReport, requireRun } from "./run.ts";

/** The report of the scope gate, as lines for a terminal. */
export function scopeLines(runtime: Runtime, run: Run): string[] {
  const report = scopeOf(runtime, run);
  if (!report) return [];
  return [
    `This task reaches other services than ${report.service} — the catalog links them:`,
    ...report.spans.map(
      (r) =>
        `  ${r.requirement.padEnd(5)} ${r.service.padEnd(24)} ${r.link ?? ""}${r.why ? `  — ${r.why}` : ""}`,
    ),
    ...(report.unconfirmed.length > 0
      ? [
          "Tied by the analysis, not linked in the catalog (a warning):",
          ...report.unconfirmed.map(
            (r) => `  ${r.requirement.padEnd(5)} ${r.service}${r.why ? `  — ${r.why}` : ""}`,
          ),
        ]
      : []),
  ];
}

/**
 * `jarvis scope <run> --cross | --single` (ADR-0025 §7): the answer at the scope gate of an sdd whose
 * impact reaches other services. `--cross`: a master run in the knowledge repository takes this run's
 * research and spec, this run ends; `--single`: this run goes on here only, and is not asked again.
 */
export async function runScope(
  ctx: CliContext,
  ref: string,
  options: { cross?: boolean; single?: boolean; resume?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    // a finished research/spec of a service: `--cross` makes the master from it (ADR-0025 §7)
    if (run.state === "COMPLETED" && options.cross) {
      if (!crossContinuationOf(runtime, run)) {
        ctx.out.error(
          `run ${shortRunId(run.id)} names no two services the catalog links: continue it as sdd (\`jarvis continue ${shortRunId(run.id)}\`)`,
        );
        throw new CliExit(EXIT.error);
      }
      const actor = await actorFor(ctx, runtime);
      const master = goCross(runtime, run, actor, "cli", crossStartOf(run));
      ctx.out.result({ run: run.id, master: master.id }, () =>
        ctx.out.line(
          `went on as sdd (cross-repos) ${shortRunId(master.id)} in ${master.workspace.repoRoot} — \`jarvis follow ${shortRunId(master.id)}\``,
        ),
      );
      return;
    }
    if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "scope") {
      ctx.out.error(`run ${shortRunId(run.id)} does not wait at the scope gate (${run.state})`);
      throw new CliExit(EXIT.error);
    }
    if (options.cross === options.single) {
      for (const line of scopeLines(runtime, run)) ctx.out.line(line);
      ctx.out.line();
      ctx.out.line(`as a task across services: jarvis scope ${shortRunId(run.id)} --cross`);
      ctx.out.line(`only this service:         jarvis scope ${shortRunId(run.id)} --single --resume`);
      return;
    }
    const actor = await actorFor(ctx, runtime);
    if (options.cross) {
      const master = goCross(runtime, run, actor, "cli");
      ctx.out.result({ run: run.id, master: master.id }, () =>
        ctx.out.line(
          `went on as sdd (cross-repos) ${shortRunId(master.id)} in ${master.workspace.repoRoot}; it goes on in the background — \`jarvis follow ${shortRunId(master.id)}\``,
        ),
      );
      return;
    }
    goSingle(runtime, run, actor, "cli");
    if (options.resume) {
      await executeAndReport(ctx, runtime, createEngine(runtime), runtime.runs.get(run.id) ?? run, false);
      return;
    }
    ctx.out.result({ run: run.id, choice: "single" }, () =>
      ctx.out.line(`only this service: \`jarvis resume ${shortRunId(run.id)}\` goes on to its plan`),
    );
  } finally {
    await runtime.close();
  }
}
