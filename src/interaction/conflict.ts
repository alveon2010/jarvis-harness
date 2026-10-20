import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { WorktreeWorkspace } from "../orchestration/worktree.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import type { Interaction } from "./store.ts";

/**
 * A person's hand edit against the work of the step the run goes on with (ADR-0019 §6.3). Told by git
 * alone, no hashes: the files a person changed since the run's last commit (uncommitted ones are a
 * human checkpoint by then, ADR-0019 §6.1) and the files the step itself changed since it began. A file
 * in both is a conflict: the step would go on with what it remembers of the file, and the person's
 * change would be lost or fought over. The run parks WAITING_HUMAN on `interaction(kind: conflict)`
 * and the person picks one of three ways out: their change, the run's, or both combined by hand.
 */
export type ConflictChoice = "mine" | "run" | "merge";

export const CONFLICT_CHOICES: readonly ConflictChoice[] = ["mine", "run", "merge"];

export interface HandEditConflict {
  /** Files both the person and the step changed. */
  readonly files: string[];
  /** Every file the person changed since the run's last commit. */
  readonly byHand: string[];
  /** The run's last commit: where "take the run's" goes back to. */
  readonly runCommit: string;
  /** The checkout's HEAD with the person's change in it. */
  readonly humanCommit: string;
}

/** The run's last commit: the newest checkpoint that has one. */
export function runCommitOf(runtime: Runtime, runId: string): string | undefined {
  return runtime.checkpoints
    .list(runId)
    .filter((c) => c.headCommit)
    .at(-1)?.headCommit;
}

/**
 * Where the step the run is at began: the newest commit checkpointed before its first round started,
 * else the run's base. Undefined when the step has not started (it has no work to conflict with).
 */
function stepStartOf(runtime: Runtime, run: Run): string | undefined {
  const first = runtime.history
    .list(run.id)
    .find((h) => h.stepId === run.currentStep && h.iteration === run.currentIteration);
  if (!first) return undefined;
  const before = runtime.checkpoints
    .list(run.id)
    .filter((c) => c.headCommit && c.createdAt <= first.startedAt)
    .at(-1)?.headCommit;
  return before ?? run.workspace.baseCommit;
}

async function namesBetween(cwd: string, from: string, to: string): Promise<string[] | undefined> {
  const r = await git(["diff", "--name-only", "--no-renames", from, to], cwd);
  if (r.code !== 0) return undefined;
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

/**
 * The conflict between the person's hand edits and the step's own work, if any. `runCommit` is the
 * run's last commit as it was before this resume took a human checkpoint.
 */
export async function handEditConflict(
  runtime: Runtime,
  run: Run,
  runCommit: string | undefined,
): Promise<HandEditConflict | undefined> {
  if (run.workspace.mode !== "worktree" || !runCommit || !run.currentStep) return undefined;
  const cwd = run.workspace.path;
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const humanCommit = head.stdout.trim();
  if (humanCommit === runCommit) return undefined;
  const start = stepStartOf(runtime, run);
  if (!start || start === runCommit) return undefined;
  const byHand = await namesBetween(cwd, runCommit, humanCommit);
  const byStep = await namesBetween(cwd, start, runCommit);
  if (!byHand || !byStep) return undefined;
  const step = new Set(byStep);
  const files = byHand.filter((f) => step.has(f));
  return files.length > 0 ? { files, byHand, runCommit, humanCommit } : undefined;
}

/** The text of the conflict's first message: what clashed and the three ways out. */
export function conflictText(run: Run, conflict: HandEditConflict): string {
  const id = shortRunId(run.id);
  return [
    `${run.currentStep} had changed ${conflict.files.length === 1 ? "a file" : "files"} you then changed by hand:`,
    ...conflict.files.map((f) => `  ${f}`),
    "",
    `Keep yours (${run.currentStep} starts again from your files): jarvis answer ${id} mine`,
    `Take the run's (yours is kept aside under refs/jarvis/set-aside): jarvis answer ${id} run`,
    `Combine both by hand in the checkout, then: jarvis answer ${id} merge`,
  ].join("\n");
}

/** Opens the conflict (or refreshes the open one) and says so in the journal. */
export function openConflict(runtime: Runtime, run: Run, conflict: HandEditConflict): Interaction {
  const meta = {
    files: conflict.files,
    byHand: conflict.byHand,
    runCommit: conflict.runCommit,
    humanCommit: conflict.humanCommit,
  };
  const open = runtime.interactions.openFor(run.id, "conflict");
  const thread = open
    ? runtime.interactions.setMeta(open.id, meta)
    : runtime.interactions.open({
        runId: run.id,
        kind: "conflict",
        stepId: run.currentStep ?? "?",
        iteration: run.currentIteration,
        origin: "workspace",
        openedBy: "jarvis",
        meta,
        message: { role: "jarvis", actor: "jarvis", text: conflictText(run, conflict) },
      });
  runtime.events.emit({
    kind: "interaction.opened",
    runId: run.id,
    ...(run.currentStep ? { stepId: run.currentStep } : {}),
    iteration: run.currentIteration,
    payload: { kind: "conflict", interactionId: thread.id, files: conflict.files },
  });
  return thread;
}

/** The files of an open conflict, as its meta keeps them. */
export function conflictFilesOf(thread: Interaction): string[] {
  const files = thread.meta.files;
  return Array.isArray(files) ? files.map(String) : [];
}

export function isConflictChoice(value: unknown): value is ConflictChoice {
  return typeof value === "string" && (CONFLICT_CHOICES as readonly string[]).includes(value);
}

/**
 * The person's way out of a conflict, done in the checkout at once:
 * - `mine` — the checkout stays as the person left it; the step starts again as a fresh round, its
 *   memory of the files is out of date;
 * - `run` — the files go back to the run's last commit and the step goes on where it stopped; the
 *   person's change stays reachable under `refs/jarvis/set-aside/<run>/<interaction>`;
 * - `merge` — the person combined both by hand: the checkout as it is now is taken, and the step goes
 *   on where it stopped.
 * Whatever is uncommitted is a human checkpoint first: nothing is reset over a person's change. The
 * decision is a `conflict-resolution` artifact; `jarvis continue` (or the page) goes on with it.
 */
export async function resolveConflict(
  runtime: Runtime,
  run: Run,
  thread: Interaction,
  choice: ConflictChoice,
  actorId: string,
): Promise<{ artifactRef: string; thread: Interaction; setAside?: string }> {
  if (thread.kind !== "conflict" || thread.state === "resolved" || thread.state === "rejected")
    throw new Error(`thread ${thread.id} is not an open conflict`);
  const workspace = WorktreeWorkspace.open(run.workspace, runtime.env);
  const edit = await workspace.humanCheckpoint(actorId);
  const head = await workspace.head();
  const runCommit = String(thread.meta.runCommit ?? "");
  let setAside: string | undefined;
  let commit = head;
  if (choice === "run") {
    if (!runCommit) throw new Error(`conflict ${thread.id} does not name the run's commit`);
    setAside = `refs/jarvis/set-aside/${shortRunId(run.id)}/${thread.id}`;
    const kept = await git(["update-ref", setAside, head], run.workspace.path);
    if (kept.code !== 0) throw new Error(`git update-ref ${setAside}: ${kept.stderr.trim()}`);
    await workspace.restore(runCommit);
    commit = runCommit;
  }
  const step = run.currentStep ?? thread.stepId;
  // `mine`: the step's memory of the files is out of date — a fresh round, as a used-up loop's rerun
  const iteration =
    choice === "mine"
      ? Math.max(runtime.history.nextIteration(run.id, step), run.currentIteration + 1)
      : run.currentIteration;
  if (iteration !== run.currentIteration) runtime.runs.update(run.id, { currentIteration: iteration });
  runtime.checkpoints.save({
    runId: run.id,
    stepId: step,
    iteration,
    kind: "step",
    headCommit: commit,
    state: { conflictResolved: thread.id, choice, ...(edit ? { humanEdit: edit.files } : {}) },
  });
  const artifact = runtime.artifacts.put({
    runId: run.id,
    type: "conflict-resolution",
    name: `${thread.id}.json`,
    content: JSON.stringify(
      {
        interactionId: thread.id,
        stepId: thread.stepId,
        choice,
        files: conflictFilesOf(thread),
        runCommit,
        humanCommit: head,
        ...(setAside ? { setAside } : {}),
        resolvedBy: actorId,
      },
      null,
      2,
    ),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: actorId, verified: false } },
    stepId: thread.stepId,
    iteration: thread.iteration,
  });
  const ref = `${artifact.artifactId}@${artifact.version}`;
  runtime.interactions.say(thread.id, { role: "human", actor: actorId, text: choice });
  const closed = runtime.interactions.close(thread.id, "resolved", actorId, ref);
  runtime.events.emit({
    kind: "interaction.resolved",
    runId: run.id,
    stepId: thread.stepId,
    payload: { interactionId: thread.id, kind: "conflict", choice, artifact: ref, by: actorId },
  });
  return { artifactRef: ref, thread: closed, ...(setAside ? { setAside } : {}) };
}

/** The conflict the run waits on is decided: `jarvis continue`, the page or the daemon go on. */
export function conflictResolved(runtime: Runtime, run: Run): boolean {
  if (run.waitingFor?.kind !== "conflict" || !run.waitingFor.interactionId) return false;
  return runtime.interactions.get(run.waitingFor.interactionId)?.state === "resolved";
}
