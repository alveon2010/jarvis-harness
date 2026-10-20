import type { SqliteEventStore } from "./events.ts";

/**
 * References from an agent's artifact to the calls it was made from (ADR-0005 §2:
 * `provenance.modelCallRefs`, `toolCallRefs`). A call has no id of its own; its `model.call` /
 * `tool.call` event has a sequence number that never changes, so a ref is `event:<seq>`.
 */
export function eventRef(seq: number): string {
  return `event:${seq}`;
}

export function seqOfRef(ref: string): number | undefined {
  const m = /^event:(\d+)$/.exec(ref);
  return m ? Number(m[1]) : undefined;
}

export interface CallRefs {
  readonly modelCallRefs: string[];
  readonly toolCallRefs: string[];
}

/**
 * The calls of one step's round — all of them, the ones before a park the step resumed from too:
 * the document is the result of the whole conversation, not of its last stretch.
 */
export function callRefsOf(
  events: Pick<SqliteEventStore, "list">,
  runId: string,
  stepId: string,
  iteration: number,
): CallRefs {
  const of = (kind: string) =>
    events
      .list({ runId, kind, limit: 1_000_000 })
      .filter((e) => e.stepId === stepId && e.iteration === iteration)
      .map((e) => eventRef(e.seq));
  return { modelCallRefs: of("model.call"), toolCallRefs: of("tool.call") };
}
