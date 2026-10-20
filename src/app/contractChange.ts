import type { Actor } from "../core/domain/actor.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import { addNote } from "../interaction/notes.ts";
import type { DecisionChannel } from "./decide.ts";
import type { Runtime } from "./runtime.ts";
import { type ContractItem, childrenOf, resumeSubtask, SPLIT_TYPE, splitOf } from "./subtasks.ts";

/**
 * A subtask asks for a contract change (ADR-0025 §6): only the master changes the contract. A subtask
 * whose analysis finds the agreed contract cannot work as split writes `contractChange` in its impact;
 * its `scope` step parks it (WAITING_HUMAN, `contract`) and records the request on the master, whose
 * page shows it at the gate. A person accepts — the split gets a new version with the contract
 * changed, the other subtasks it touches get it as a note, the asking one analyses its impact again
 * with it — or rejects: the asking subtask goes on with the contract as agreed.
 */
export interface ContractChangeAsk {
  readonly item: string;
  readonly kind?: ContractItem["kind"];
  readonly change: string;
  readonly why: string;
}

export interface ContractChangeRequest extends ContractChangeAsk {
  /** The impact that asks, `artifactId@version`: one request per analysis. */
  readonly id: string;
  readonly key: string;
  readonly service: string;
  readonly run: string;
  readonly at: string;
}

export interface ContractChangeDecision {
  readonly request: string;
  readonly choice: "accept" | "reject";
  /** Accepted: the change as written into the split (the person may have edited it). */
  readonly change?: string;
  readonly why?: string;
  readonly by?: string;
  /** Accepted: the split's new version. */
  readonly version?: number;
}

export const CONTRACT_REQUESTED = "contract.changeRequested";
export const CONTRACT_DECIDED = "contract.changeDecided";
/** The scope step's outcome after an accepted change: back to the impact, with the new contract. */
export const CONTRACT_CHANGED = "contract_changed";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const KINDS: readonly string[] = ["endpoint", "topic", "dto"];

/** What the subtask's latest impact asks, with the id of that analysis. */
export function contractChangeAsked(
  runtime: Runtime,
  run: Run,
): { readonly id: string; readonly ask: ContractChangeAsk } | undefined {
  const a = runtime.artifacts.listLatest(run.id, "impact")[0];
  if (!a) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(runtime.artifacts.text(a)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const c = (doc.contractChange ?? undefined) as Record<string, unknown> | undefined;
  const item = str(c?.item);
  const change = str(c?.change);
  if (!c || !item || !change) return undefined;
  const kind = KINDS.includes(String(c.kind)) ? (c.kind as ContractItem["kind"]) : undefined;
  return {
    id: `${a.artifactId}@${a.version}`,
    ask: { item, ...(kind ? { kind } : {}), change, why: str(c.why) ?? "" },
  };
}

/** Every request recorded on the master, oldest first. */
export function contractRequestsOf(runtime: Runtime, masterId: string): ContractChangeRequest[] {
  const out: ContractChangeRequest[] = [];
  for (const e of runtime.events.list({ runId: masterId, kind: CONTRACT_REQUESTED, limit: 10_000 })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const [id, key, service, run, item, change] = [p.id, p.key, p.service, p.run, p.item, p.change].map(str);
    if (!id || !key || !service || !run || !item || !change || out.some((r) => r.id === id)) continue;
    const kind = KINDS.includes(String(p.kind)) ? (p.kind as ContractItem["kind"]) : undefined;
    out.push({
      id,
      key,
      service,
      run,
      item,
      ...(kind ? { kind } : {}),
      change,
      why: str(p.why) ?? "",
      at: e.ts,
    });
  }
  return out;
}

/** The person's decision on a request, if any. */
export function contractDecisionOf(
  runtime: Runtime,
  masterId: string,
  requestId: string,
): ContractChangeDecision | undefined {
  const e = runtime.events
    .list({ runId: masterId, kind: CONTRACT_DECIDED, limit: 10_000 })
    .filter((x) => (x.payload as Record<string, unknown> | undefined)?.request === requestId)
    .at(-1);
  const p = (e?.payload ?? {}) as Record<string, unknown>;
  if (!e || (p.choice !== "accept" && p.choice !== "reject")) return undefined;
  return {
    request: requestId,
    choice: p.choice,
    ...(str(p.change) ? { change: str(p.change) as string } : {}),
    ...(str(p.why) ? { why: str(p.why) as string } : {}),
    ...(e.actor ? { by: e.actor.replace(/^(user|service|ci):/, "") } : {}),
    ...(typeof p.version === "number" ? { version: p.version } : {}),
  };
}

/** The requests that wait for a person: not decided, their subtask's run still waiting for it. */
export function pendingContractRequests(runtime: Runtime, master: Run): ContractChangeRequest[] {
  return contractRequestsOf(runtime, master.id).filter((r) => {
    if (contractDecisionOf(runtime, master.id, r.id)) return false;
    const run = runtime.runs.get(r.run);
    return run !== undefined && !isTerminal(run.state);
  });
}

/** The subtask's request on its master, once per analysis. */
export function recordContractRequest(
  runtime: Runtime,
  master: Run,
  run: Run,
  asked: { readonly id: string; readonly ask: ContractChangeAsk },
): void {
  if (contractRequestsOf(runtime, master.id).some((r) => r.id === asked.id)) return;
  const parent = run.options?.parent;
  const service = splitOf(runtime, master)?.subtasks.find((s) => s.key === parent?.key)?.service;
  runtime.events.emit({
    kind: CONTRACT_REQUESTED,
    runId: master.id,
    payload: { id: asked.id, key: parent?.key, service, run: run.id, ...asked.ask },
  });
}

const itemLine = (c: Pick<ContractItem, "kind" | "id" | "change">) => `${c.kind} ${c.id}: ${c.change}`;

/**
 * Accepted: the split's contract item takes the change (a new item when the request names one the
 * contract does not have), as a new version of the split; the other subtasks of its sides that still
 * run get it as a note; the asking one goes on — its impact runs again with the new contract.
 */
export function acceptContractChange(
  runtime: Runtime,
  master: Run,
  request: ContractChangeRequest,
  actor: Actor,
  channel: DecisionChannel,
  edited?: string,
): { version: number; told: string[]; done: string[] } {
  const split = runtime.artifacts.listLatest(master.id, SPLIT_TYPE)[0];
  const current = splitOf(runtime, master);
  if (!split || !current) throw new Error("the master has no split: nothing to change");
  const change = edited?.trim() || request.change;
  const doc = JSON.parse(runtime.artifacts.text(split)) as Record<string, unknown>;
  const contract = (Array.isArray(doc.contract) ? doc.contract : []) as Array<Record<string, unknown>>;
  let item = contract.find((c) => c.id === request.item);
  if (item) item.change = change;
  else {
    item = {
      kind: request.kind ?? "dto",
      id: request.item,
      change,
      producer: request.service,
      consumers: [],
    };
    contract.push(item);
  }
  const by = `${actor.kind}:${actor.id}`;
  const next = runtime.artifacts.put({
    runId: master.id,
    type: SPLIT_TYPE,
    name: split.name,
    content: JSON.stringify({ ...doc, contract }, null, 2),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: actor.id, verified: false } },
    sourceRefs: [request.id],
    ...(split.stepId ? { stepId: split.stepId } : {}),
    ...(split.iteration !== undefined ? { iteration: split.iteration } : {}),
  });
  runtime.events.emit({
    kind: CONTRACT_DECIDED,
    runId: master.id,
    actor: by,
    payload: {
      request: request.id,
      key: request.key,
      choice: "accept",
      change,
      version: next.version,
      channel,
    },
  });
  const line = itemLine({ kind: item.kind as ContractItem["kind"], id: request.item, change });
  const sides = new Set([String(item.producer), ...((item.consumers as string[] | undefined) ?? [])]);
  const told: string[] = [];
  const done: string[] = [];
  for (const [key, run] of childrenOf(runtime, master.id)) {
    const sub = current.subtasks.find((s) => s.key === key);
    if (!sub || key === request.key || !sides.has(sub.service)) continue;
    if (isTerminal(run.state)) {
      done.push(key);
      continue;
    }
    addNote(
      runtime,
      run,
      `The master changed the contract (asked by subtask ${request.key}, ${request.service}): ${line}. Keep it as now written.`,
      actor.id,
    );
    told.push(key);
  }
  const asking = runtime.runs.get(request.run);
  if (asking && !isTerminal(asking.state)) {
    addNote(
      runtime,
      asking,
      `The master accepted the contract change: ${line}. Keep it as now written; the impact is analysed again with it.`,
      actor.id,
    );
    resumeSubtask(runtime, asking);
  }
  return { version: next.version, told, done };
}

/** Rejected: the asking subtask goes on with the contract as agreed. */
export function rejectContractChange(
  runtime: Runtime,
  master: Run,
  request: ContractChangeRequest,
  actor: Actor,
  channel: DecisionChannel,
  why?: string,
): void {
  runtime.events.emit({
    kind: CONTRACT_DECIDED,
    runId: master.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: {
      request: request.id,
      key: request.key,
      choice: "reject",
      ...(why?.trim() ? { why: why.trim() } : {}),
      channel,
    },
  });
  const agreed = splitOf(runtime, master)?.contract.find((c) => c.id === request.item);
  const asking = runtime.runs.get(request.run);
  if (!asking || isTerminal(asking.state)) return;
  addNote(
    runtime,
    asking,
    `The master keeps the contract as agreed${agreed ? `: ${itemLine(agreed)}` : ""}${why?.trim() ? ` — ${why.trim()}` : ""}. Work with it as written.`,
    actor.id,
  );
  resumeSubtask(runtime, asking);
}
