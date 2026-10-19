import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { layoutOf } from "../core/paths.ts";
import { type Catalog, catalogOf, type NamedService, namedServices } from "../knowledge/catalog.ts";
import { newRunId, shortRunId } from "../storage/runStore.ts";
import { crossCatalogText } from "./crossCatalog.ts";
import { handOff } from "./handoff.ts";
import type { Runtime } from "./runtime.ts";
import { MASTER_WORKFLOW, resumeMaster } from "./subtasks.ts";

/**
 * Whether an sdd in a service is a task across services (ADR-0025 §7). After its impact analysis the
 * `scope` step compares what the analysis says another service must do (`elsewhere`) with the
 * contract catalog: a requirement tied to a service the catalog links to this one stops the run at a
 * gate — go on as a task across services, or only this service. A tie the catalog does not confirm is
 * a warning, never a stop: weak models err both ways. A plain sdd of one service passes on at once.
 */
export interface ScopeRow {
  readonly requirement: string;
  readonly service: string;
  readonly why: string;
  /** The catalog's link between the two services: `orders.created`, `GET /delivery-slots/{id}`. */
  readonly link?: string;
}

export interface ScopeReport {
  readonly service: string;
  /** Confirmed by the catalog: these stop the run at the gate. */
  readonly spans: readonly ScopeRow[];
  /** What the analysis tied to another service and the catalog does not link: said, not a stop. */
  readonly unconfirmed: readonly ScopeRow[];
  /** What this service provides that the change touches, and who uses it. */
  readonly consumers: ReadonlyArray<{ readonly what: string; readonly services: readonly string[] }>;
}

export const SCOPE_TYPE = "scope";

function json(runtime: Runtime, runId: string, type: string): Record<string, unknown> | undefined {
  const a = runtime.artifacts.listLatest(runId, type)[0];
  if (!a) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(a)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const linkBetween = (catalog: Catalog, a: string, b: string): string | undefined =>
  catalog.links.find((l) => (l.producer === a && l.consumer === b) || (l.producer === b && l.consumer === a))
    ?.what;

/** For a run in a service of a knowledge repository (not a subtask already): what its impact reaches. */
export function scopeOf(runtime: Runtime, run: Run): ScopeReport | undefined {
  if (run.options?.parent) return undefined;
  const layout = layoutOf(run.workspace.repoRoot);
  const service = layout.meta?.service;
  if (!layout.meta || !service) return undefined;
  const catalog = catalogOf(layout.meta.root);
  const impact = json(runtime, run.id, "impact") ?? {};
  const services = new Set(Object.keys(runtime.loaded.meta?.repos ?? {}));
  for (const s of catalog.services.keys()) services.add(s);
  const spans: ScopeRow[] = [];
  const unconfirmed: ScopeRow[] = [];
  for (const e of Array.isArray(impact.elsewhere) ? impact.elsewhere : []) {
    const o = e as Record<string, unknown>;
    const other = typeof o.service === "string" ? o.service : "";
    if (!other || other === service) continue;
    const row = {
      requirement: typeof o.requirement === "string" ? o.requirement : "",
      service: other,
      why: typeof o.why === "string" ? o.why : "",
    };
    const link = services.has(other) ? linkBetween(catalog, service, other) : undefined;
    if (link) spans.push({ ...row, link });
    else unconfirmed.push(row);
  }
  // what this service provides in the files the change touches, and who uses it
  const affected = new Set(
    (Array.isArray(impact.affected) ? impact.affected : [])
      .map((a) => (a as { path?: unknown }).path)
      .filter((p): p is string => typeof p === "string"),
  );
  const own = catalog.services.get(service);
  const consumers: Array<{ what: string; services: string[] }> = [];
  const add = (what: string) => {
    const users = [
      ...new Set(
        catalog.links.filter((l) => l.producer === service && l.what.endsWith(what)).map((l) => l.consumer),
      ),
    ];
    if (users.length > 0 && !consumers.some((c) => c.what === what))
      consumers.push({ what, services: users });
  };
  for (const t of own?.produces ?? []) if (affected.has(t.file)) add(t.topic);
  for (const e of own?.serves ?? []) if (affected.has(e.file)) add(e.path);
  return { service, spans, unconfirmed, consumers };
}

/** The person's answer at the scope gate, if any: `cross` or `single`. */
export function scopeDecision(runtime: Runtime, runId: string): "cross" | "single" | undefined {
  const e = runtime.events.list({ runId, kind: "scope.decided", limit: 1000 }).at(-1);
  const choice = e?.payload?.choice;
  return choice === "cross" || choice === "single" ? choice : undefined;
}

/**
 * «Only this service»: the run goes on to its plan; the other services stay tasks of their own. Kept
 * with the run: a loop or «Run again» does not ask again.
 */
export function goSingle(runtime: Runtime, run: Run, actor: Actor, channel: "cli" | "ui"): void {
  runtime.events.emit({
    kind: "scope.decided",
    runId: run.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: { choice: "single", channel },
  });
}

/**
 * «Continue as sdd (cross-repos)» (also from a finished research): a master run in the knowledge
 * repository with this run's research and approved spec, from its split (`startAt`), the catalog made for it; this run
 * ends there — its service gets a subtask of its own. The master goes on in the background, in the
 * knowledge repository, with its configuration.
 */
export function goCross(
  runtime: Runtime,
  run: Run,
  actor: Actor,
  channel: "cli" | "ui",
  startAt = "split",
): Run {
  const meta = runtime.loaded.meta;
  if (!meta) throw new Error("not a service of a knowledge repository: no task across services");
  const master = runtime.runs.create({
    id: newRunId(),
    task: run.task,
    workflow: MASTER_WORKFLOW,
    owner: actor,
    workspace: { mode: "cwd", repoRoot: meta.root, path: meta.root, baseRef: "HEAD" },
    dataClass: run.dataClass,
    ...(run.profile ? { profile: run.profile } : {}),
  });
  const carried = handOff(runtime, run, master, startAt);
  // the catalog comes before the research; a master that starts past it gets it made now
  const catalog = crossCatalogText(runtime, runtime.runs.get(master.id) ?? master);
  if (catalog !== undefined)
    runtime.artifacts.put({
      runId: master.id,
      type: "catalog",
      name: "catalog.md",
      content: catalog,
      provenance: { kind: "tool", capability: "cross.catalog" },
      stepId: "catalog",
      iteration: 1,
    });
  runtime.events.emit({
    kind: "run.created",
    runId: master.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: {
      task: run.task,
      workflow: MASTER_WORKFLOW,
      continuedFrom: run.id,
      startAt,
      carried: carried.length,
    },
  });
  runtime.events.emit({
    kind: "run.driver",
    runId: master.id,
    payload: { by: channel === "ui" ? "ui" : "cli" },
  });
  runtime.events.emit({
    kind: "scope.decided",
    runId: run.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: { choice: "cross", channel, master: master.id },
  });
  if (run.state !== "COMPLETED" && run.state !== "CANCELLED")
    runtime.runs.transition(run.id, "CANCELLED", {
      reason: `went on as a task across services: ${MASTER_WORKFLOW} ${shortRunId(master.id)}`,
    });
  resumeMaster(runtime, runtime.runs.get(master.id) ?? master);
  return master;
}

/**
 * A finished research or spec of a service whose findings name two services or more the catalog
 * links (ADR-0025 §7): its continuation offers «Continue to sdd (cross-repos)», recommended.
 */
export function crossContinuationOf(runtime: Runtime, run: Run): readonly NamedService[] | undefined {
  if (
    run.state !== "COMPLETED" ||
    (run.workflow !== "research" && run.workflow !== "spec") ||
    run.options?.parent
  )
    return undefined;
  const layout = layoutOf(run.workspace.repoRoot);
  if (!layout.meta?.service) return undefined;
  const catalog = catalogOf(layout.meta.root);
  const text = [
    run.task,
    ...["research", "spec"]
      .flatMap((t) => runtime.artifacts.listLatest(run.id, t))
      .map((a) => runtime.artifacts.text(a)),
  ].join("\n");
  const names = new Set([...Object.keys(runtime.loaded.meta?.repos ?? {}), ...catalog.services.keys()]);
  const named = namedServices(catalog, text, [...names]);
  const set = new Set(named.map((n) => n.service));
  if (!set.has(layout.meta.service)) named.unshift({ service: layout.meta.service, by: "this run" });
  set.add(layout.meta.service);
  const linked = catalog.links.some((l) => set.has(l.producer) && set.has(l.consumer));
  return named.length >= 2 && linked ? named : undefined;
}

/** Where a master made from a finished run starts: after the research, or after an approved spec. */
export const crossStartOf = (run: Run): string => (run.workflow === "spec" ? "split" : "spec");
