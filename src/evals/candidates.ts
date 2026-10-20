import type { Runtime } from "../app/runtime.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { caseOfRun, casesRootOf } from "./runToCase.ts";

/**
 * Eval case candidates (ADR-0012 §3): a run that ended with its implementation accepted, on which Jarvis
 * learned something — a person sent a document back at a gate, a back edge went round, a person edited
 * the spec, research or impact — is worth keeping as a case. The run's end records it (an event); no case
 * files are written: a person looks at the list (`jarvis evals candidates`, the run page) and makes the
 * case (`jarvis evals run-to-case`) or dismisses it. A run that went straight through teaches nothing a
 * case would keep.
 */
export type CandidateReason =
  /** A person sent this document back at its gate (`request_changes`). */
  | { readonly kind: "sent-back"; readonly type: string; readonly times: number }
  /** A back edge went round (ADR-0004), not one a send-back took. */
  | { readonly kind: "loop"; readonly edge: string; readonly times: number }
  /** A person edited this document: human-provenance versions (ADR-0005). */
  | { readonly kind: "edited"; readonly type: string; readonly versions: readonly number[] };

export interface EvalCandidate {
  readonly runId: string;
  readonly task: string;
  readonly workflow: string;
  /** When the run ended and was noted. */
  readonly at: string;
  readonly reasons: readonly CandidateReason[];
}

export const CANDIDATE_EVENT = "evals.candidate";
export const DISMISSED_EVENT = "evals.candidate.dismissed";

/** Who runs the evals' own runs: their gates and loops are no person's correction (src/evals/runner.ts). */
export const EVAL_ACTOR: Actor = { kind: "user", id: "evals@jarvis", verified: false };

/** The documents whose human versions are the gold of a case (src/evals/runToCase.ts). */
const EDITED_TYPES = ["spec", "research", "impact"];

/**
 * Why the run is worth a case, or undefined when it is not one: not COMPLETED, its implementation not
 * accepted by a person, an eval's own run, or nothing learned on it.
 */
export function candidateReasons(runtime: Runtime, run: Run): CandidateReason[] | undefined {
  if (run.state !== "COMPLETED" || run.owner.id === EVAL_ACTOR.id) return undefined;
  const impl = runtime.artifacts.listLatest(run.id, "implementation")[0];
  const accepted = impl ? runtime.artifacts.isApproved(impl.artifactId) : undefined;
  if (!accepted?.approved || accepted.approval?.actor.id === EVAL_ACTOR.id) return undefined;
  const reasons: CandidateReason[] = [];
  const sentBackOutcomes = new Set<string>();
  const artifacts = runtime.artifacts.listLatest(run.id);
  for (const a of artifacts) {
    const back = runtime.artifacts
      .approvalsFor(a.artifactId)
      .filter((x) => x.decision === "request_changes" && x.actor.id !== EVAL_ACTOR.id);
    for (const x of back) sentBackOutcomes.add(x.outcome ?? "request_changes");
    if (back.length > 0) reasons.push({ kind: "sent-back", type: a.type, times: back.length });
  }
  for (const [edge, times] of Object.entries(run.iterations).sort(([a], [b]) => a.localeCompare(b))) {
    const outcome = edge.slice(edge.lastIndexOf("#") + 1);
    if (times > 0 && !sentBackOutcomes.has(outcome)) reasons.push({ kind: "loop", edge, times });
  }
  for (const a of artifacts.filter((x) => EDITED_TYPES.includes(x.type))) {
    const versions = runtime.artifacts
      .versions(a.artifactId)
      .filter((v) => v.provenance.kind === "human" && v.provenance.actor.id !== EVAL_ACTOR.id)
      .map((v) => v.version);
    if (versions.length > 0) reasons.push({ kind: "edited", type: a.type, versions });
  }
  return reasons.length > 0 ? reasons : undefined;
}

/** At the run's end: notes it as a candidate when it is one. Never throws — a note never fails a run. */
export function noteEvalCandidate(runtime: Runtime, run: Run): void {
  try {
    const reasons = candidateReasons(runtime, run);
    if (!reasons) return;
    if (runtime.events.list({ runId: run.id, kind: CANDIDATE_EVENT, limit: 1 }).length > 0) return;
    runtime.events.emit({
      kind: CANDIDATE_EVENT,
      runId: run.id,
      actor: "jarvis",
      payload: { task: run.task, workflow: run.workflow, reasons },
    });
  } catch {
    // the note is a convenience: `jarvis evals candidates` and the run page work without it
  }
}

/** The candidates still open: noted, not dismissed, not made into a case yet. Newest first. */
export function evalCandidates(runtime: Runtime): EvalCandidate[] {
  const dismissed = new Set(
    runtime.events
      .list({ kind: DISMISSED_EVENT, limit: 1_000_000 })
      .map((e) => e.runId)
      .filter((id): id is string => typeof id === "string"),
  );
  const out: EvalCandidate[] = [];
  for (const e of runtime.events.list({ kind: CANDIDATE_EVENT, limit: 1_000_000 }).reverse()) {
    if (!e.runId || dismissed.has(e.runId) || out.some((c) => c.runId === e.runId)) continue;
    const run = runtime.runs.get(e.runId);
    if (!run || caseOfRun(casesRootOf(run.workspace.repoRoot), run.id)) continue;
    const p = (e.payload ?? {}) as { reasons?: CandidateReason[] };
    out.push({ runId: run.id, task: run.task, workflow: run.workflow, at: e.ts, reasons: p.reasons ?? [] });
  }
  return out;
}

/** The run is no case: off the list, its note kept. */
export function dismissEvalCandidate(runtime: Runtime, runId: string, actor: string): void {
  runtime.events.emit({ kind: DISMISSED_EVENT, runId, actor, payload: {} });
}

export function isDismissed(runtime: Runtime, runId: string): boolean {
  return runtime.events.list({ runId, kind: DISMISSED_EVENT, limit: 1 }).length > 0;
}

/** One reason in a line: `spec sent back 2×`, `back edge review->implementation#changes 1×`, `spec edited (v3)`. */
export function reasonLine(r: CandidateReason): string {
  if (r.kind === "sent-back") return `${r.type} sent back ${r.times}×`;
  if (r.kind === "loop") return `back edge ${r.edge} ${r.times}×`;
  return `${r.type} edited by a person (${r.versions.map((v) => `v${v}`).join(", ")})`;
}
