import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { resolveConflict } from "../../src/interaction/conflict.ts";
import { ModelError } from "../../src/models/errors.ts";
import type { StepContext } from "../../src/orchestration/types.ts";
import { ACTOR, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0019 §6.3: a hand edit of a file the step itself changed parks the run on a conflict. */
let sb: Sandbox;
let rt: Runtime;
let repo: string;

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: GIT_ENV }).trim();
const read = (file: string) => readFileSync(join(repo, file), "utf8");
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
  repo = join(sb.root, "orders-api");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  write("a.ts", "export const a = 1;\n");
  write("b.ts", "export const b = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const owner = { owner: "cli:test:1" };
const WF = workflowOf({
  name: "edit",
  entry: "work",
  steps: [{ id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "DONE" } }],
});

/** The step changes a.ts, then stops on a quota window mid-way; later rounds record what they saw. */
function setup() {
  const seen: Array<{ iteration: number; restored: unknown; a: string }> = [];
  const engine = engineFor(rt, [WF], {
    work: async (ctx: StepContext) => {
      if (seen.length === 0 && !ctx.restored) {
        seen.push({ iteration: ctx.iteration, restored: undefined, a: read("a.ts") });
        write("a.ts", "export const a = 2; // the run\n");
        ctx.saveCheckpoint({ toolCalls: 3 });
        throw new ModelError("quota_exhausted", "pool exhausted", { retryAfterMs: 1, modelId: "flash" });
      }
      seen.push({ iteration: ctx.iteration, restored: ctx.restored, a: read("a.ts") });
      return { status: "success" };
    },
  });
  const base = git(["rev-parse", "HEAD"]);
  const run = rt.runs.create({
    task: "ABC-42 orders filter",
    workflow: "edit",
    owner: ACTOR,
    workspace: { mode: "worktree", repoRoot: repo, path: repo, baseRef: "HEAD", baseCommit: base },
    dataClass: rt.loaded.config.dataClass,
  });
  return { engine, run, seen };
}

describe("a hand edit against the step's work", () => {
  it("parks WAITING_HUMAN on a conflict naming the file both changed, and asks again until decided", async () => {
    const { engine, run, seen } = setup();
    expect((await engine.execute(run.id, owner)).run.state).toBe("WAITING_BUDGET");
    write("a.ts", "export const a = 3; // mine\n");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.state).toBe("WAITING_HUMAN");
    expect(parked.exitCode).toBe(10);
    expect(parked.run.waitingFor?.kind).toBe("conflict");
    const thread = rt.interactions.openFor(run.id, "conflict");
    expect(thread?.id).toBe(parked.run.waitingFor?.interactionId);
    expect(thread?.meta.files).toEqual(["a.ts"]);
    expect(rt.interactions.messages(thread?.id as string)[0]?.text).toContain("jarvis answer");
    expect(seen).toHaveLength(1);
    // the hand edit is committed, never reset away
    expect(read("a.ts")).toBe("export const a = 3; // mine\n");
    expect(git(["status", "--porcelain"])).toBe("");

    const again = await engine.execute(run.id, owner);
    expect(again.run.waitingFor?.kind).toBe("conflict");
    expect(rt.interactions.listForRun(run.id).filter((i) => i.kind === "conflict")).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("`run` takes the run's files, keeps the person's aside, and the step goes on where it stopped", async () => {
    const { engine, run, seen } = setup();
    await engine.execute(run.id, owner);
    write("a.ts", "export const a = 3; // mine\n");
    const parked = await engine.execute(run.id, owner);
    const thread = rt.interactions.openFor(run.id, "conflict");
    if (!thread) throw new Error("no conflict");
    const done = await resolveConflict(rt, parked.run, thread, "run", "dev@example.com");
    expect(read("a.ts")).toBe("export const a = 2; // the run\n");
    expect(done.setAside).toMatch(/^refs\/jarvis\/set-aside\//);
    expect(git(["show", `${done.setAside}:a.ts`])).toBe("export const a = 3; // mine");
    const record = rt.artifacts.listLatest(run.id, "conflict-resolution")[0];
    expect(JSON.parse(rt.artifacts.text(record as never))).toMatchObject({ choice: "run", files: ["a.ts"] });
    expect(record?.provenance.kind).toBe("human");
    expect(rt.interactions.get(thread.id)?.state).toBe("resolved");

    const finished = await engine.execute(run.id, owner);
    expect(finished.run.state).toBe("COMPLETED");
    expect(seen[1]).toEqual({
      iteration: 1,
      restored: { toolCalls: 3 },
      a: "export const a = 2; // the run\n",
    });
  });

  it("`mine` keeps the person's files and the step starts again as a fresh round", async () => {
    const { engine, run, seen } = setup();
    await engine.execute(run.id, owner);
    write("a.ts", "export const a = 3; // mine\n");
    const parked = await engine.execute(run.id, owner);
    const thread = rt.interactions.openFor(run.id, "conflict");
    if (!thread) throw new Error("no conflict");
    await resolveConflict(rt, parked.run, thread, "mine", "dev@example.com");
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    expect(seen[1]).toEqual({ iteration: 2, restored: undefined, a: "export const a = 3; // mine\n" });
  });

  it("`merge` takes the checkout as the person combined it and the step goes on where it stopped", async () => {
    const { engine, run, seen } = setup();
    await engine.execute(run.id, owner);
    write("a.ts", "export const a = 3; // mine\n");
    const parked = await engine.execute(run.id, owner);
    const thread = rt.interactions.openFor(run.id, "conflict");
    if (!thread) throw new Error("no conflict");
    write("a.ts", "export const a = 4; // both\n");
    await resolveConflict(rt, parked.run, thread, "merge", "dev@example.com");
    expect(git(["status", "--porcelain"])).toBe("");
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    expect(seen[1]).toEqual({ iteration: 1, restored: { toolCalls: 3 }, a: "export const a = 4; // both\n" });
  });

  it("a hand edit of another file is no conflict: a human checkpoint, and the step goes on", async () => {
    const { engine, run, seen } = setup();
    await engine.execute(run.id, owner);
    write("b.ts", "export const b = 2; // mine\n");
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    expect(rt.interactions.listForRun(run.id).filter((i) => i.kind === "conflict")).toHaveLength(0);
    expect(seen[1]?.restored).toEqual({ toolCalls: 3 });
    expect(
      rt.checkpoints.list(run.id).some((c) => (c.state.humanEdit as string[] | undefined)?.[0] === "b.ts"),
    ).toBe(true);
  });

  it("the person's own commit in the checkout is taken, not reset away", async () => {
    const { engine, run } = setup();
    await engine.execute(run.id, owner);
    write("b.ts", "export const b = 2; // committed by hand\n");
    git(["commit", "-q", "-am", "by hand"]);
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    expect(read("b.ts")).toBe("export const b = 2; // committed by hand\n");
    expect(git(["log", "--format=%s"]).split("\n")).toContain("by hand");
  });
});
