import { type EffectDecision, resolveEffect, unresolvedEffectOf } from "../../app/effects.ts";
import { createRuntime } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis effect <run> [--happened | --again] [--note <text>]` — answers a run that waits on an effect
 * whose outcome is unknown (ADR-0002 §2, src/app/effects.ts). Without a flag: what was tried and where
 * to look.
 */
export async function runEffect(
  ctx: CliContext,
  runRef: string,
  options: { happened?: boolean; again?: boolean; note?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = runtime.runs.resolve(runRef);
    if (!run) {
      ctx.out.error(`run "${runRef}" not found`);
      throw new CliExit(EXIT.error);
    }
    const open = unresolvedEffectOf(runtime, run);
    if (!open) {
      ctx.out.error(`run ${shortRunId(run.id)} does not wait on an effect`);
      throw new CliExit(EXIT.error);
    }
    if (options.happened && options.again) {
      ctx.out.error("say one: --happened or --again");
      throw new CliExit(EXIT.error);
    }
    const decision: EffectDecision | undefined = options.happened
      ? "happened"
      : options.again
        ? "again"
        : undefined;
    const short = shortRunId(run.id);
    if (!decision) {
      ctx.out.result(
        {
          run: run.id,
          capability: open.record.capability,
          key: open.record.key,
          marker: open.marker,
          args: open.args,
        },
        () => {
          const st = ctx.out.style;
          ctx.out.line(`run ${short} waits: did ${st.name(open.record.capability)} happen?`);
          ctx.out.line(
            st.muted(
              `  step ${open.record.stepId} #${open.record.iteration}, started ${open.record.createdAt}`,
            ),
          );
          ctx.out.line(
            `  look for ${st.cmd(open.marker)} where it writes (a comment, a commit trailer, a PR description)`,
          );
          ctx.out.line(st.muted(`  what it was asked: ${JSON.stringify(open.args).slice(0, 400)}`));
          ctx.out.line();
          ctx.out.line(`${st.muted("it is there    ")} ${st.cmd(`jarvis effect ${short} --happened`)}`);
          ctx.out.line(`${st.muted("it is not there")} ${st.cmd(`jarvis effect ${short} --again`)}`);
        },
      );
      return;
    }
    const resolved = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    if (!resolved.actor) {
      ctx.out.error("cannot determine the actor (ADR-0006)");
      throw new CliExit(EXIT.error);
    }
    resolveEffect(runtime, run, decision, resolved.actor, "cli", options.note);
    ctx.out.result({ run: run.id, decision }, () => {
      const st = ctx.out.style;
      ctx.out.line(
        decision === "happened"
          ? `${st.ok("✓")} recorded as done — the run goes on without doing it again`
          : `${st.ok("✓")} recorded as not done — the run does it again`,
      );
      ctx.out.line(`${st.muted("go on")} ${st.cmd(`jarvis continue ${short}`)}`);
    });
  } finally {
    await runtime.close();
  }
}
