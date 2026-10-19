import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import { mainCourse } from "./restart.ts";
import type { Runtime } from "./runtime.ts";

/**
 * «Redo from here» (`jarvis redo <run> <step> --note`): a run that waits, is paused or failed goes
 * back to one of the steps it went through, with a person's note for that step; the steps after it
 * run again as the workflow goes. The same run and its checkout: what the run wrote stays, and the
 * steps that write code work on top of it. A run that ended (cancelled, completed) has no checkout
 * to go on in — it starts again from the step as a new run (`jarvis restart --from --note`).
 */
export const REDO_EVENT = "step.redo";

/** States a run may go back from in place. */
export const REDOABLE = new Set<Run["state"]>(["WAITING_HUMAN", "WAITING_BUDGET", "SUSPENDED", "FAILED"]);

export interface RedoRequest {
  readonly step: string;
  /** The round of the step the note is for. */
  readonly iteration: number;
  readonly note?: string;
  readonly actor?: string;
  readonly seq: number;
}

/** Whether a run may go back in place now: not while a process drives it. */
export function redoableInPlace(run: Run, now = Date.now()): boolean {
  if (REDOABLE.has(run.state)) return true;
  // RUNNING with no live process (Ctrl-C, a closed terminal)
  return run.state === "RUNNING" && (!run.lease || Date.parse(run.lease.until) < now);
}

/** The steps a run may go back to: those of the main course it went through, and the one it is on. */
export function redoTargets(runtime: Runtime, run: Run, workflow: WorkflowDefinition): string[] {
  const ran = new Set(runtime.history.list(run.id).map((h) => h.stepId));
  return mainCourse(workflow)
    .map((s) => s.id)
    .filter((id) => ran.has(id) || id === run.currentStep);
}

/** Asks the run to go back to `step` with `note`; the next resume enters it there. */
export function requestRedo(
  runtime: Runtime,
  run: Run,
  workflow: WorkflowDefinition,
  step: string,
  actor: Actor,
  channel: "cli" | "ui",
  note?: string,
): RedoRequest {
  if (!redoableInPlace(run))
    throw new Error(
      run.state === "RUNNING"
        ? "the run is working: pause it first (jarvis pause), or wait for it to stop"
        : `the run is ${run.state}: it goes on as a new run (jarvis restart --from ${step})`,
    );
  const targets = redoTargets(runtime, run, workflow);
  if (!targets.includes(step))
    throw new Error(`"${step}" is not a step this run went through: ${targets.join(", ") || "none"}`);
  const iteration = runtime.history.nextIteration(run.id, step);
  runtime.events.emit({
    kind: REDO_EVENT,
    runId: run.id,
    stepId: step,
    actor: `${actor.kind}:${actor.id}`,
    payload: { step, iteration, channel, ...(note?.trim() ? { note: note.trim() } : {}) },
  });
  return {
    step,
    iteration,
    ...(note?.trim() ? { note: note.trim() } : {}),
    actor: actor.id,
    seq: runtime.events.list({ runId: run.id, kind: REDO_EVENT, limit: 100_000 }).at(-1)?.seq ?? 0,
  };
}

/** A note for the first round of a run that starts again from a step (`jarvis restart --note`). */
export function noteForStart(runtime: Runtime, run: Run, step: string, actor: Actor, note: string): void {
  if (!note.trim()) return;
  runtime.events.emit({
    kind: REDO_EVENT,
    runId: run.id,
    stepId: step,
    actor: `${actor.kind}:${actor.id}`,
    payload: { step, iteration: 1, note: note.trim(), start: true },
  });
}

const requestOf = (e: {
  seq: number;
  actor?: string;
  payload?: Record<string, unknown>;
}): RedoRequest | undefined => {
  const p = e.payload ?? {};
  if (typeof p.step !== "string" || typeof p.iteration !== "number") return undefined;
  return {
    step: p.step,
    iteration: p.iteration,
    ...(typeof p.note === "string" ? { note: p.note } : {}),
    ...(e.actor ? { actor: e.actor.replace(/^(user|service|ci):/, "") } : {}),
    seq: e.seq,
  };
};

/** A «redo» asked since the run last ran, not applied yet. */
export function pendingRedo(runtime: Runtime, runId: string): RedoRequest | undefined {
  const asked = runtime.events.list({ runId, kind: REDO_EVENT, limit: 100_000 }).at(-1);
  if (!asked || asked.payload?.start === true) return undefined;
  const ran = runtime.events
    .list({ runId, kind: "run.state", limit: 100_000 })
    .filter((e) => e.payload?.state === "RUNNING")
    .at(-1);
  return ran && ran.seq > asked.seq ? undefined : requestOf(asked);
}

/** The notes a person left for this round of a step. */
export function redoNotesFor(
  runtime: Runtime,
  runId: string,
  step: string,
  iteration: number,
): RedoRequest[] {
  return runtime.events
    .list({ runId, kind: REDO_EVENT, limit: 100_000 })
    .map(requestOf)
    .filter(
      (r): r is RedoRequest => r !== undefined && r.step === step && r.iteration === iteration && !!r.note,
    );
}
