import { BudgetExceededError, type StepUsage, usageFromEvents } from "../budget/runBudget.ts";
import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";
import { splitOf } from "./subtasks.ts";

/**
 * The budget of a task across services (ADR-0025 §6): the master's is the sum of its subtasks'
 * (`budget.perRun` of each subtask's service, with what a person granted its runs); the master's own
 * steps count apart. What the subtasks spent counts every run of a subtask, a cancelled one retried
 * too: once the sum is spent, a subtask makes no more model calls — it parks on a budget stop like
 * any run, and «more» on it grows its share and so the master's sum.
 */
export type BudgetDimensionOfRun = keyof StepUsage;
const DIMENSIONS: readonly BudgetDimensionOfRun[] = ["outputTokens", "inputTokens", "requests"];

export type Caps = Partial<Record<BudgetDimensionOfRun, number>>;

export interface MasterBudget {
  /** Summed over the subtasks; a dimension only when every subtask has a cap on it. */
  readonly limit: Caps;
  /** What the subtasks' runs spent, all of them. */
  readonly spent: StepUsage;
  /** The master's own steps (research, spec, split), apart from the sum. */
  readonly own: StepUsage;
  /** A dimension used up, if any. */
  readonly exhausted?: {
    readonly dimension: BudgetDimensionOfRun;
    readonly used: number;
    readonly cap: number;
  };
}

const capsOf = (v: unknown): Caps => {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Caps = {};
  for (const d of DIMENSIONS) {
    const n = o[d];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[d] = n;
  }
  return out;
};

const ZERO: StepUsage = { outputTokens: 0, inputTokens: 0, requests: 0 };
const plus = (a: StepUsage, b: StepUsage): StepUsage => ({
  outputTokens: a.outputTokens + b.outputTokens,
  inputTokens: a.inputTokens + b.inputTokens,
  requests: a.requests + b.requests,
});

/** What a person granted a run on its budget stops: on its own cap or on the master's sum. */
function grantedTo(runtime: Runtime, runId: string): StepUsage {
  let out = ZERO;
  for (const e of runtime.events.list({ runId, kind: "budget.grant", limit: 10_000 })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.scope !== "perRun" && p.scope !== "master") continue;
    out = plus(out, { ...ZERO, ...capsOf(p) });
  }
  return out;
}

/** The master's budget: its subtasks' caps and spending summed. Undefined without a split. */
export function masterBudgetOf(runtime: Runtime, master: Run): MasterBudget | undefined {
  const split = splitOf(runtime, master);
  if (!split || split.subtasks.length === 0) return undefined;
  // each subtask's cap, as its process recorded it from its service's configuration; before it
  // started, the knowledge repository's (recorded when the master spawned them)
  const recorded = new Map<string, Caps>();
  for (const e of runtime.events.list({ runId: master.id, kind: "subtask.run", limit: 10_000 })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (typeof p.key === "string" && p.budget !== undefined) recorded.set(p.key, capsOf(p.budget));
  }
  const spawned = runtime.events.list({ runId: master.id, kind: "subtasks.spawned", limit: 100 }).at(-1);
  const fallback = capsOf((spawned?.payload as Record<string, unknown> | undefined)?.budget);
  const runs = runtime.runs
    .list({ includeTerminal: true, limit: 1000 })
    .filter((r) => r.options?.parent?.runId === master.id);
  const db = runtime.db.db;
  let spent = ZERO;
  for (const r of runs) spent = plus(spent, usageFromEvents(db, r.id));
  const limit: Caps = {};
  for (const d of DIMENSIONS) {
    let sum = 0;
    let capped = true;
    for (const s of split.subtasks) {
      const cap = (recorded.get(s.key) ?? fallback)[d];
      if (cap === undefined) {
        capped = false;
        break;
      }
      const granted = runs
        .filter((r) => r.options?.parent?.key === s.key)
        .reduce((n, r) => n + grantedTo(runtime, r.id)[d], 0);
      sum += cap + granted;
    }
    if (capped) limit[d] = sum;
  }
  const exhaustedAt = DIMENSIONS.find((d) => {
    const cap = limit[d];
    // a request is refused before it is made: one more must fit
    return cap !== undefined && (d === "requests" ? spent[d] + 1 > cap : spent[d] >= cap);
  });
  const cap = exhaustedAt ? limit[exhaustedAt] : undefined;
  return {
    limit,
    spent,
    own: usageFromEvents(db, master.id),
    ...(exhaustedAt && cap !== undefined
      ? { exhausted: { dimension: exhaustedAt, used: spent[exhaustedAt], cap } }
      : {}),
  };
}

/**
 * Before a subtask's model call: the master's sum spent — the call is not made, the subtask parks on
 * a budget stop of scope `master`. A run that is not a subtask passes.
 */
export function checkMasterBudget(runtime: Runtime, run: Run): void {
  const masterId = run.options?.parent?.runId;
  const master = masterId ? runtime.runs.get(masterId) : undefined;
  if (!master) return;
  const budget = masterBudgetOf(runtime, master);
  const ex = budget?.exhausted;
  if (ex) throw new BudgetExceededError("master", ex.dimension, ex.used, ex.cap);
}

/** For a terminal: `budget (sum of the subtasks'): 12,000 of 60,000 output tokens · …`. */
export function masterBudgetLine(b: MasterBudget): string {
  const units: Record<BudgetDimensionOfRun, string> = {
    outputTokens: "output tokens",
    inputTokens: "input tokens",
    requests: "model requests",
  };
  const n = (x: number) => x.toLocaleString("en-US");
  const parts = DIMENSIONS.filter((d) => b.limit[d] !== undefined || b.spent[d] > 0).map((d) => {
    const cap = b.limit[d];
    return cap === undefined ? `${n(b.spent[d])} ${units[d]}` : `${n(b.spent[d])} of ${n(cap)} ${units[d]}`;
  });
  return `budget (sum of the subtasks'): ${parts.length > 0 ? parts.join(" · ") : "nothing spent yet"}${
    Object.keys(b.limit).length === 0 ? " — no cap: budget.perRun is not set" : ""
  }${b.exhausted ? " — spent: a subtask stops on a budget stop before its next model call" : ""}`;
}
