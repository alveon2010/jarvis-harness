import type { EventSink, StoredEvent } from "../telemetry/events.ts";
import type { RedactionReport, RedactionSample } from "./redactor.ts";

/**
 * Observability of the Redactor itself (ADR-0010 §4): every replacement is a `security.redaction`
 * event with its boundary, the detector types and a count — never the value, not even its start.
 * `jarvis doctor` sums them over a period.
 */
export type RedactionBoundary = "model-request" | "tool" | "artifact";

export const REDACTION_BOUNDARIES: readonly RedactionBoundary[] = ["model-request", "tool", "artifact"];

export interface RedactionRecord {
  readonly boundary: RedactionBoundary;
  readonly runId?: string;
  readonly stepId?: string;
  /** The tool whose output was masked (boundary `tool`). */
  readonly capability?: string;
  /**
   * Shapes of high-entropy guesses for telling a false positive (`jarvis show`); tool output only,
   * where the agent then asked for the masked thing.
   */
  readonly samples?: readonly RedactionSample[];
}

/** Emits one event for a redaction pass that replaced something; a clean pass leaves no trace. */
export function recordRedaction(
  events: EventSink,
  report: Pick<RedactionReport, "count" | "byType">,
  at: RedactionRecord,
): void {
  if (report.count <= 0) return;
  events.emit({
    kind: "security.redaction",
    ...(at.runId ? { runId: at.runId } : {}),
    ...(at.stepId ? { stepId: at.stepId } : {}),
    payload: {
      boundary: at.boundary,
      ...(at.capability ? { capability: at.capability } : {}),
      count: report.count,
      byType: { ...report.byType },
      ...(at.samples && at.samples.length > 0 ? { samples: at.samples } : {}),
    },
  });
}

export interface RedactionStats {
  readonly since: string;
  readonly total: number;
  /** How many redaction passes replaced something (one event each). */
  readonly events: number;
  readonly runs: number;
  readonly byBoundary: Record<string, number>;
  readonly byType: Record<string, number>;
}

/** Sums `security.redaction` events at or after `since`. */
export function summarizeRedactions(events: readonly StoredEvent[], since: Date): RedactionStats {
  const from = since.toISOString();
  const byBoundary: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const runs = new Set<string>();
  let total = 0;
  let count = 0;
  for (const e of events) {
    if (e.kind !== "security.redaction" || e.ts < from) continue;
    const p = (e.payload ?? {}) as { boundary?: unknown; count?: unknown; byType?: unknown };
    const n = typeof p.count === "number" ? p.count : 0;
    // events written before the boundary was named came from tool output
    const boundary = typeof p.boundary === "string" ? p.boundary : "tool";
    total += n;
    count += 1;
    if (e.runId) runs.add(e.runId);
    byBoundary[boundary] = (byBoundary[boundary] ?? 0) + n;
    if (p.byType && typeof p.byType === "object")
      for (const [type, k] of Object.entries(p.byType as Record<string, unknown>))
        if (typeof k === "number") byType[type] = (byType[type] ?? 0) + k;
  }
  return { since: from, total, events: count, runs: runs.size, byBoundary, byType };
}

export interface RedactionWindows {
  readonly last24h: RedactionStats;
  readonly last7d: RedactionStats;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The two periods `doctor` shows: the last day and the last week. */
export function redactionWindows(
  source: { list(options: { kind: string; since: string; limit: number }): StoredEvent[] },
  now: Date = new Date(),
): RedactionWindows {
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const events = source.list({ kind: "security.redaction", since: week.toISOString(), limit: 1_000_000 });
  return {
    last24h: summarizeRedactions(events, new Date(now.getTime() - DAY_MS)),
    last7d: summarizeRedactions(events, week),
  };
}

/** `12 (tool 9, model-request 3; assignment ×7, bearer ×5)`, or `none`. */
export function formatRedactionStats(stats: RedactionStats): string {
  if (stats.total === 0) return "none";
  const sorted = (r: Record<string, number>) =>
    Object.entries(r)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const where = sorted(stats.byBoundary)
    .map(([b, n]) => `${b} ${n}`)
    .join(", ");
  const types = sorted(stats.byType)
    .map(([t, n]) => `${t} ×${n}`)
    .join(", ");
  return `${stats.total} in ${stats.runs} run${stats.runs === 1 ? "" : "s"} (${where}; ${types})`;
}

/**
 * A burst of high-entropy guesses usually means the project keeps long generated values in code
 * (ADR-0010 §4): something to look at in the project, or a false positive to report.
 */
export const HIGH_ENTROPY_BURST = 20;

export function highEntropyBurst(stats: RedactionStats): boolean {
  return (stats.byType["high-entropy"] ?? 0) >= HIGH_ENTROPY_BURST;
}
