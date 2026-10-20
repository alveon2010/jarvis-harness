import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import type { StoredEvent } from "../telemetry/events.ts";

/**
 * What one more round of a back edge is likely to cost (ADR-0004 §5): the model output of each past
 * round of the loop — from a start of the edge's target step to the next — and their median. A round is
 * the steps from the target to the step that sent the work back, in the workflow's order. Also the pool
 * those rounds spent most from, to ask the budget about.
 */
export interface RoundCost {
  /** Median output tokens of a past round. */
  readonly outputTokens: number;
  readonly rounds: number;
  readonly pool: string;
}

export function roundCostOf(
  events: readonly StoredEvent[],
  workflow: WorkflowDefinition,
  edge: { readonly from: string; readonly to: string },
  poolOf: (modelId: string) => string,
): RoundCost | undefined {
  const order = workflow.steps.map((s) => s.id);
  const a = order.indexOf(edge.to);
  const b = order.indexOf(edge.from);
  if (a < 0 || b < 0 || a > b) return undefined;
  // composite children count with their parent
  const inLoop = new Set(order.slice(a, b + 1));
  for (const s of workflow.steps) if (inLoop.has(s.id)) for (const c of s.children) inLoop.add(c);

  const rounds: number[] = [];
  const spent = new Map<string, number>();
  let current: number | undefined;
  for (const e of events) {
    if (e.kind === "step.start" && (e.stepId ?? (e.payload?.stepId as string | undefined)) === edge.to) {
      if (current !== undefined) rounds.push(current);
      current = 0;
      continue;
    }
    if (e.kind !== "model.call" || current === undefined || !e.stepId || !inLoop.has(e.stepId)) continue;
    const out = Number((e.payload as { outputTokens?: unknown } | undefined)?.outputTokens) || 0;
    current += out;
    const modelId = String((e.payload as { modelId?: unknown } | undefined)?.modelId ?? "");
    if (modelId) spent.set(poolOf(modelId), (spent.get(poolOf(modelId)) ?? 0) + out);
  }
  if (current !== undefined) rounds.push(current);
  const paid = rounds.filter((r) => r > 0);
  if (paid.length === 0) return undefined;
  const sorted = [...paid].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
  const pool = [...spent.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  return pool ? { outputTokens: median, rounds: paid.length, pool } : undefined;
}
