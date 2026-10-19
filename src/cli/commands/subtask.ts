import { createEngine } from "../../app/engine.ts";
import { handOff } from "../../app/handoff.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import {
  type ContractItem,
  childrenOf,
  isDone,
  libraryBlockers,
  libraryMapOf,
  type Publication,
  publicationsOf,
  publishLibrary,
  resumeMaster,
  type Split,
  type Subtask,
  scheduleSubtasks,
  splitOf,
  startSubtask,
  subtasksOf,
} from "../../app/subtasks.ts";
import { isTerminal, type Run } from "../../core/domain/run.ts";
import { newRunId, shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";
import { actorFor, executeAndReport, prepareWorkspace, requireRun } from "./run.ts";

/**
 * `jarvis subtask …` (ADR-0025 §6): the subtasks of a task across services. A subtask is a plain run
 * with its own id — `status`, `approve`, `resume` work with it as with any run; these commands manage
 * the master's side: list, start one now, retry, drop.
 */

function masterOrExit(ctx: CliContext, runtime: Runtime, ref: string): { master: Run; split: Split } {
  const master = requireRun(ctx, runtime, ref);
  const split = splitOf(runtime, master);
  if (!split) {
    ctx.out.error(
      `run ${shortRunId(master.id)} has no approved split: not a task across services, or not split yet`,
    );
    throw new CliExit(EXIT.error);
  }
  return { master, split };
}

function subtaskOrExit(ctx: CliContext, split: Split, which: string): Subtask {
  const sub = split.subtasks.find((s) => s.key === which || s.service === which);
  if (!sub) {
    ctx.out.error(`no subtask "${which}": ${split.subtasks.map((s) => `${s.key} ${s.service}`).join(", ")}`);
    throw new CliExit(EXIT.error);
  }
  return sub;
}

/** What the subtask's own run is told: its part, the requirements it covers, the contract it keeps. */
/** A library of the task the subtask's service uses: changed first, published for its build. */
export interface UsedLibrary {
  readonly service: string;
  readonly key: string;
  readonly task: string;
  /** The names the service's build depends on it by (`services.<lib>.publishes`). */
  readonly publishes: readonly string[];
  readonly publication?: Publication;
}

export function subtaskTask(
  master: Run,
  sub: Subtask,
  split: Split,
  libraries: readonly UsedLibrary[] = [],
): string {
  const first = (master.task.split("\n")[0] ?? master.task).trim();
  const contract = split.contract.filter(
    (c) => c.producer === sub.service || c.consumers.includes(sub.service),
  );
  const line = (c: ContractItem) =>
    `- ${c.kind} ${c.id}: ${c.change} — ${c.producer} ${c.kind === "topic" ? "sends" : "serves"}${c.consumers.length > 0 ? `; ${c.consumers.join(", ")} ${c.kind === "topic" ? "read" : "call"}` : ""}${c.producer === sub.service ? " (this service produces it)" : ""}`;
  return [
    sub.task,
    "",
    `Part of a task across services: ${first} (${shortRunId(master.id)}) — subtask ${sub.key} of ${split.subtasks.length}, ${sub.service}.`,
    ...(sub.requirements.length > 0
      ? [`Requirements of the task's specification it covers: ${sub.requirements.join(", ")}.`]
      : []),
    ...(contract.length > 0
      ? [
          "The contract between the services (the task's: keep it as written; if it cannot hold, say so in the impact's risks — the master changes it, not this run):",
          ...contract.map(line),
        ]
      : []),
    ...(libraries.length > 0
      ? [
          "Libraries this service uses that the task changed first (their change is accepted): build against the new version — bump the dependency to it as the impact's first change.",
          ...libraries.map(
            (l) =>
              `- ${l.service} (subtask ${l.key}): ${l.task}${
                l.publishes.length > 0 ? ` — the dependency to move: ${l.publishes.join(", ")}` : ""
              }${l.publication?.version ? ` — version ${l.publication.version}` : ""}${
                l.publication?.command
                  ? `, published on this machine by \`${l.publication.command}\` (Maven: the local repository, mavenLocal(); npm: the packed .tgz in ${l.publication.at ?? "its checkout"})`
                  : l.publication?.skipped
                    ? ` — not published: ${l.publication.skipped}`
                    : ""
              }`,
          ),
        ]
      : []),
  ].join("\n");
}

/** The library subtasks a subtask waits for, with their publications. */
export function usedLibraries(runtime: Runtime, master: Run, sub: Subtask, split: Split): UsedLibrary[] {
  const published = publicationsOf(runtime, master.id);
  const map = libraryMapOf(runtime);
  return libraryBlockers(sub, split, map).flatMap((key) => {
    const lib = split.subtasks.find((s) => s.key === key);
    if (!lib) return [];
    const publication = published.get(key);
    return [
      {
        service: lib.service,
        key,
        task: lib.task,
        publishes: map.publishes.get(lib.service) ?? [],
        ...(publication ? { publication } : {}),
      },
    ];
  });
}

/** `jarvis subtask run <master> <key>` — the subtask's process in its service's repository. */
export async function runSubtaskRun(ctx: CliContext, masterRef: string, which: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master, split } = masterOrExit(ctx, runtime, masterRef);
    const sub = subtaskOrExit(ctx, split, which);
    if (loaded.meta?.service !== sub.service) {
      ctx.out.error(
        `subtask ${sub.key} is ${sub.service}'s; this repository is ${loaded.meta?.service ? `the service ${loaded.meta.service}` : "not a service of a knowledge repository"}`,
      );
      throw new CliExit(EXIT.error);
    }
    const existing = childrenOf(runtime, master.id).get(sub.key);
    if (existing && existing.state !== "CANCELLED") {
      ctx.out.error(
        `subtask ${sub.key} runs as ${shortRunId(existing.id)} (${existing.state}): \`jarvis resume ${shortRunId(existing.id)}\``,
      );
      throw new CliExit(EXIT.error);
    }
    const actor = await actorFor(ctx, runtime);
    const engine = createEngine(runtime);
    const runId = newRunId();
    const task = subtaskTask(master, sub, split, usedLibraries(runtime, master, sub, split));
    const workspace = await prepareWorkspace(ctx, runtime, runId, task, undefined);
    const run = runtime.runs.create({
      id: runId,
      task,
      workflow: "sdd",
      owner: actor,
      workspace,
      dataClass: loaded.config.dataClass,
      ...(loaded.config.profile ? { profile: loaded.config.profile } : {}),
      options: { parent: { runId: master.id, key: sub.key } },
    });
    // the master's research and approved spec: the subtask starts at its impact
    const carried = handOff(runtime, master, run, "impact");
    runtime.events.emit({
      kind: "run.created",
      runId: run.id,
      actor: `${actor.kind}:${actor.id}`,
      payload: {
        task,
        workflow: "sdd",
        parent: { runId: master.id, key: sub.key },
        startAt: "impact",
        carried: carried.length,
      },
    });
    // the page resumes it after a decision, as a run started there
    runtime.events.emit({ kind: "run.driver", runId: run.id, payload: { by: "master", master: master.id } });
    runtime.events.emit({
      kind: "subtask.run",
      runId: master.id,
      payload: { key: sub.key, service: sub.service, run: run.id },
    });
    await executeAndReport(ctx, runtime, engine, runtime.runs.get(run.id) ?? run, false);
  } finally {
    await runtime.close();
  }
}

/** `jarvis subtask list <master>`. */
export async function runSubtaskList(ctx: CliContext, masterRef: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master } = masterOrExit(ctx, runtime, masterRef);
    const views = subtasksOf(runtime, master);
    ctx.out.result(
      views.map((v) => ({
        key: v.subtask.key,
        service: v.subtask.service,
        state: v.state,
        ...(v.run ? { run: v.run.id, step: v.run.currentStep } : {}),
        ...(v.waitsFor ? { waitsFor: v.waitsFor } : {}),
        ...(v.published ? { published: v.published } : {}),
      })),
      () => {
        ctx.out.line(
          `${master.task.split("\n")[0]} (${shortRunId(master.id)}) — ${views.filter(isDone).length} of ${views.length} done`,
        );
        for (const v of views)
          ctx.out.line(
            `  ${v.subtask.key.padEnd(3)} ${v.subtask.service.padEnd(24)} ${v.state.padEnd(14)} ${v.run ? `${shortRunId(v.run.id)}${v.run.currentStep ? ` · ${v.run.currentStep}` : ""}` : ""}${v.waitsFor ? `waits for ${v.waitsFor.join(", ")} to be accepted and published` : ""}${v.published ? `${v.published.ok ? "published" : "publish-local failed"}${v.published.version ? ` ${v.published.version}` : ""}` : ""}`,
          );
      },
    );
  } finally {
    await runtime.close();
  }
}

/** `jarvis subtask start <master> <key|service>` — now, past the parallel limit. */
export async function runSubtaskStart(ctx: CliContext, masterRef: string, which: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master, split } = masterOrExit(ctx, runtime, masterRef);
    const sub = subtaskOrExit(ctx, split, which);
    const view = subtasksOf(runtime, master).find((v) => v.subtask.key === sub.key);
    if (view && view.state !== "queued" && view.state !== "blocked") {
      ctx.out.error(
        `subtask ${sub.key} is ${view.state}${view.run ? ` (${shortRunId(view.run.id)})` : ""}: nothing to start`,
      );
      throw new CliExit(EXIT.error);
    }
    if (view?.state === "blocked") {
      // a person starts it without waiting for its libraries: against the version it has
      const actor = await actorFor(ctx, runtime);
      runtime.events.emit({
        kind: "subtask.startNow",
        runId: master.id,
        actor: `${actor.kind}:${actor.id}`,
        payload: { key: sub.key, service: sub.service, waitedFor: view.waitsFor ?? [], channel: "cli" },
      });
    }
    const started = startSubtask(runtime, master, sub.key);
    if (!started.ok) {
      ctx.out.error(started.why);
      throw new CliExit(EXIT.error);
    }
    ctx.out.result({ key: sub.key, service: sub.service, started: true }, () =>
      ctx.out.line(
        `subtask ${sub.key} (${sub.service}) starts in its repository${view?.state === "blocked" ? ", without waiting for its libraries" : ""}; \`jarvis subtask list ${shortRunId(master.id)}\``,
      ),
    );
  } finally {
    await runtime.close();
  }
}

/** `jarvis subtask retry <master> <key|service>` — a failed one goes on, a cancelled one starts anew. */
export async function runSubtaskRetry(ctx: CliContext, masterRef: string, which: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master, split } = masterOrExit(ctx, runtime, masterRef);
    const sub = subtaskOrExit(ctx, split, which);
    const run = childrenOf(runtime, master.id).get(sub.key);
    if (run && !isTerminal(run.state)) {
      ctx.out.result({ key: sub.key, run: run.id, resume: true }, () =>
        ctx.out.line(
          `subtask ${sub.key} is ${run.state}: \`jarvis resume ${shortRunId(run.id)}\` in ${run.workspace.repoRoot}`,
        ),
      );
      return;
    }
    if (run?.state === "COMPLETED") {
      ctx.out.error(`subtask ${sub.key} is completed: nothing to retry`);
      throw new CliExit(EXIT.error);
    }
    const started = startSubtask(runtime, master, sub.key);
    if (!started.ok) {
      ctx.out.error(started.why);
      throw new CliExit(EXIT.error);
    }
    ctx.out.result({ key: sub.key, service: sub.service, started: true }, () =>
      ctx.out.line(`subtask ${sub.key} (${sub.service}) starts again in its repository`),
    );
  } finally {
    await runtime.close();
  }
}

/** `jarvis subtask drop <master> <key|service>` — out of the task; the master goes on without it. */
export async function runSubtaskDrop(ctx: CliContext, masterRef: string, which: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master, split } = masterOrExit(ctx, runtime, masterRef);
    const sub = subtaskOrExit(ctx, split, which);
    const actor = await actorFor(ctx, runtime);
    runtime.events.emit({
      kind: "subtask.dropped",
      runId: master.id,
      actor: `${actor.kind}:${actor.id}`,
      payload: { key: sub.key, service: sub.service },
    });
    const views = subtasksOf(runtime, master);
    const all = views.every(isDone);
    const current = runtime.runs.get(master.id) ?? master;
    if (all && current.waitingFor?.kind === "children") resumeMaster(runtime, current);
    ctx.out.result({ key: sub.key, dropped: true, masterResumed: all }, () =>
      ctx.out.line(
        `subtask ${sub.key} (${sub.service}) dropped from the task${all ? "; every other subtask is done — the master goes on" : ""}`,
      ),
    );
  } finally {
    await runtime.close();
  }
}

/** `jarvis subtask publish <master> <key|service>` — in the library's repository: publish-local again. */
export async function runSubtaskPublish(ctx: CliContext, masterRef: string, which: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { master, split } = masterOrExit(ctx, runtime, masterRef);
    const sub = subtaskOrExit(ctx, split, which);
    if (loaded.meta?.service !== sub.service) {
      ctx.out.error(`subtask ${sub.key} is ${sub.service}'s: run this in its repository`);
      throw new CliExit(EXIT.error);
    }
    const run = childrenOf(runtime, master.id).get(sub.key);
    if (run?.state !== "COMPLETED") {
      ctx.out.error(
        `subtask ${sub.key} is ${run?.state ?? "not started"}: it publishes once its change is accepted`,
      );
      throw new CliExit(EXIT.error);
    }
    const p = await publishLibrary(runtime, master, sub, run);
    const started = p.ok ? scheduleSubtasks(runtime, master) : [];
    ctx.out.result({ key: sub.key, ...p, started }, () => {
      ctx.out.line(
        p.ok
          ? `${sub.service} ${p.skipped ? "not published: no publish-local" : `published${p.version ? ` ${p.version}` : ""}`}${started.length > 0 ? `; started ${started.join(", ")}` : ""}`
          : `publish-local failed: ${p.command}`,
      );
      if (!p.ok && p.tail) ctx.out.line(p.tail);
    });
    if (!p.ok) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
