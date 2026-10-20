import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { type EffectRecord, effectMarker } from "../storage/effects.ts";
import type { Runtime } from "./runtime.ts";

/**
 * The way forward from an effect whose outcome nobody can tell (ADR-0002 §2): the run started a change
 * in an external system — a comment, a branch, a PR — and lost track of whether it happened, and the
 * provider cannot check by its marker. A person looks where the marker would be and says: it happened
 * (the journal records it done, the run goes on without repeating it) or it did not (it runs again).
 * Before, the run stood waiting with no command to answer it.
 */
export interface UnresolvedEffect {
  readonly record: EffectRecord;
  /** What was asked of the external system, as recorded. */
  readonly args: unknown;
  /** The text the effect leaves behind to be found by (ADR-0002 §3). */
  readonly marker: string;
}

/** The effect a run waits on, if it waits on one. */
export function unresolvedEffectOf(runtime: Runtime, run: Run): UnresolvedEffect | undefined {
  if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "effect") return undefined;
  const record = runtime.effects
    .byRun(run.id)
    .filter((r) => r.status === "unknown" || r.status === "intended")
    .at(-1);
  if (!record) return undefined;
  return { record, args: runtime.effects.args(record), marker: effectMarker(run.id, record.key) };
}

export type EffectDecision = "happened" | "again";

/** Records the person's answer in the journal; the run goes on with `jarvis continue` or the page. */
export function resolveEffect(
  runtime: Runtime,
  run: Run,
  decision: EffectDecision,
  actor: Actor,
  channel: "cli" | "ui",
  note?: string,
): EffectRecord {
  const open = unresolvedEffectOf(runtime, run);
  if (!open) throw new Error(`run ${run.id} does not wait on an effect`);
  const by = `${actor.kind}:${actor.id}`;
  const record =
    decision === "happened"
      ? runtime.effects.complete(open.record.id, { resolvedBy: by, ...(note ? { note } : {}) })
      : // a recorded failure is run again under the same key (EffectJournal.begin)
        runtime.effects.fail(open.record.id, `a person said it did not happen${note ? `: ${note}` : ""}`);
  runtime.events.emit({
    kind: "effect.resolved",
    runId: run.id,
    stepId: open.record.stepId,
    iteration: open.record.iteration,
    actor: by,
    payload: {
      capability: open.record.capability,
      key: open.record.key,
      decision,
      channel,
      ...(note ? { note } : {}),
    },
  });
  return record;
}
