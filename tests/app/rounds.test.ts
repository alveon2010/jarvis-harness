import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goOnRequested, requestGoOn, requestRerun } from "../../src/app/decide.ts";
import { requestRedo } from "../../src/app/redo.ts";
import { failuresOf, roundStop, roundsOf } from "../../src/app/rounds.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { checksAskOf, pauseAfterRequested, requestPauseAfter, setChecksAsk } from "../../src/app/steer.ts";
import { excerptOf, excerptText } from "../../src/orchestration/tools/excerpt.ts";
import type { StepContext, StepOutcome } from "../../src/orchestration/types.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
const owner = { owner: "cli:test:1" };

const rounding = (actual: string) => ({
  check: "test",
  command: "./gradlew test",
  ok: false,
  failures: [
    {
      suite: "com.example.OrderTotalTest",
      name: "discount is rounded once()",
      message: `expected: 99.90 but was: ${actual}\n\tat OrderTotalTest.kt:58`,
      expected: "99.90",
      actual,
      stack: [{ file: "src/main/kotlin/OrderTotal.kt", line: 41, changed: true }],
    },
  ],
  tests: { failed: 1, total: 14 },
});
const notStarted = {
  check: "test",
  command: "./gradlew test",
  ok: false,
  notStarted: true,
  excerpt: "e: OrderTotal.kt:41:5 Unresolved reference: percentOf\nBUILD FAILED in 4s",
};

/** A workflow whose verify writes the checks of each round as `results[round - 1]` says. */
function workflow(results: unknown[][]) {
  const wf = workflowOf({
    name: "rounds",
    entry: "implementation",
    steps: [
      {
        id: "implementation",
        kind: "agentic",
        agent: "implementation",
        transitions: { onSuccess: "verify" },
      },
      {
        id: "verify",
        kind: "agentic",
        agent: "verify",
        outputs: ["checks"],
        transitions: {
          onSuccess: "review",
          onOutcome: { defects_found: { to: "implementation", maxIterations: 2 } },
        },
      },
      { id: "review", kind: "agentic", agent: "review", transitions: { onSuccess: "DONE" } },
      { id: "spec", kind: "agentic", agent: "spec", transitions: { onSuccess: "implementation" } },
    ],
  });
  const calls: string[] = [];
  const verify = async (ctx: StepContext): Promise<StepOutcome> => {
    calls.push(`verify#${ctx.iteration}`);
    const these = results[ctx.iteration - 1] ?? [];
    const a = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "checks",
      name: "checks.json",
      content: JSON.stringify({ results: these }),
      provenance: { kind: "tool", capability: "project.checks" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    const failed = these.some((r) => (r as { ok?: boolean }).ok === false);
    return failed
      ? {
          status: "success",
          outcome: "defects_found",
          outputs: [`${a.artifactId}@${a.version}`],
          reason: "test failed",
        }
      : { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
  };
  const engine = engineFor(rt, [wf], {
    implementation: async (ctx) => {
      calls.push(`implementation#${ctx.iteration}`);
      return writeArtifact(ctx, "implementation", JSON.stringify({ summary: "Moved the rounding." }));
    },
    verify,
    review: async (ctx) => {
      calls.push(`review#${ctx.iteration}`);
      return { status: "success" };
    },
  });
  return { engine, calls };
}

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

describe("rounds of checks, compared by Jarvis", () => {
  it("a failure is its check, test and assertion — times and temporary paths do not count", () => {
    const a = failuresOf({ results: [rounding("99.89")] }).failures[0];
    const b = failuresOf({ results: [{ ...rounding("99.89"), tests: { failed: 1, total: 15 } }] })
      .failures[0];
    expect(a?.signature).toBe(b?.signature);
    expect(a?.at).toBe("src/main/kotlin/OrderTotal.kt:41");
    expect(failuresOf({ results: [rounding("99.88")] }).failures[0]?.signature).not.toBe(a?.signature);
    // the base commit's failures are not the run's; a check with no report: what its output says broke
    const pre = { ...rounding("1"), failures: [{ ...rounding("1").failures[0], preexisting: true }] };
    const lint = {
      check: "lint",
      ok: false,
      tail: "src/a.ts\n  3:1  error  no-unused-vars\n✖ 1 problem (in 812ms)",
    };
    const both = failuresOf({ results: [pre, lint] });
    expect(both.failures.map((f) => f.check)).toEqual(["lint"]);
    expect(both.failures[0]?.message).toContain("no-unused-vars");
    expect(failuresOf({ results: [notStarted] }).notStarted).toEqual(["test"]);
  });

  it("the same failure twice: the run asks before the next round, the rounds left kept", async () => {
    const { engine, calls } = workflow([[rounding("99.89")], [rounding("99.89")]]);
    const run = createRun(rt, "rounds");
    const result = await engine.execute(run.id, owner);
    expect(calls).toEqual(["implementation#1", "verify#1", "implementation#2", "verify#2"]);
    expect(result.run.state).toBe("WAITING_HUMAN");
    expect(result.run.waitingFor).toEqual({ kind: "loop", detail: "verify->implementation#defects_found" });
    expect(result.run.stateReason).toContain("failed as the round before");
    // one round went back by itself; the second is the person's to give
    expect(result.run.iterations).toEqual({ "verify->implementation#defects_found": 1 });
    const record = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(run.id, "loop-exhausted")[0] as never),
    );
    expect(record).toMatchObject({ why: "same-failure", round: 2 });
    expect(roundsOf(rt, run.id).map((r) => r.failures.length)).toEqual([1, 1]);
  });

  it("different failures go on by themselves; no test ran asks at once; when-rounds-end never asks early", async () => {
    const progress = workflow([[rounding("99.89")], [rounding("99.80")], []]);
    const a = createRun(rt, "rounds");
    expect((await progress.engine.execute(a.id, owner)).run.state).toBe("COMPLETED");
    expect(progress.calls.filter((c) => c.startsWith("verify"))).toHaveLength(3);

    const broken = workflow([[notStarted]]);
    const b = createRun(rt, "rounds");
    const stopped = await broken.engine.execute(b.id, owner);
    expect(stopped.run.state).toBe("WAITING_HUMAN");
    expect(stopped.run.stateReason).toContain("ran no test");
    expect(broken.calls).toEqual(["implementation#1", "verify#1"]);

    expect(roundStop(rt, b, 1, "when-rounds-end")).toBeUndefined();
    expect(roundStop(rt, a, 1, "every-failure")?.why).toBe("every-failure");
  });

  it("the person decides: a hint goes back to implementation, «go on» passes verify, «run again» checks again", async () => {
    const { engine, calls } = workflow([[rounding("99.89")], [rounding("99.89")], [rounding("99.89")], []]);
    const wf = engine.workflow("rounds");
    const run = createRun(rt, "rounds");
    await engine.execute(run.id, owner);
    // a hint: implementation gets one more round with it
    requestRedo(
      rt,
      rt.runs.get(run.id) as never,
      wf,
      "implementation",
      ACTOR,
      "ui",
      "PromoClient rounds the discount",
    );
    const again = await engine.execute(run.id, owner);
    expect(calls.slice(4)).toEqual(["implementation#3", "verify#3"]);
    expect(again.run.state).toBe("WAITING_HUMAN");
    // fixed by hand: the checks run again, no round of implementation
    requestRerun(rt, again.run, ACTOR, "ui");
    const fixed = await engine.execute(run.id, owner);
    expect(calls.slice(6)).toEqual(["verify#4", "review#1"]);
    expect(fixed.run.state).toBe("COMPLETED");

    // «not this task's»: verify counts as passed, the run goes to review
    const other = workflow([[rounding("99.89")], [rounding("99.89")]]);
    const r2 = createRun(rt, "rounds");
    const parked = await other.engine.execute(r2.id, owner);
    requestGoOn(rt, parked.run, ACTOR, "ui", ["OrderTotalTest › discount is rounded once"], "flaky on CI");
    expect(goOnRequested(rt, r2.id)?.failures).toEqual(["OrderTotalTest › discount is rounded once"]);
    const went = await other.engine.execute(r2.id, owner);
    expect(other.calls.slice(4)).toEqual(["review#1"]);
    expect(went.run.state).toBe("COMPLETED");
  });
});

describe("the whole output, what broke kept", () => {
  it("keeps the lines around an error and the end, folds the rest", () => {
    const lines = [
      ...Array.from({ length: 300 }, (_, i) => `> Task :compile${i}`),
      "e: OrderTotal.kt:41:5 Unresolved reference: percentOf",
      ...Array.from({ length: 200 }, (_, i) => `> Task :other${i}`),
      "BUILD FAILED in 4s",
    ];
    const ex = excerptOf(lines.join("\n"));
    expect(ex.hits).toBe(2);
    expect(ex.parts[0]).toEqual({ kind: "fold", from: 0, count: 298 });
    const text = excerptText(lines.join("\n"));
    expect(text).toContain("Unresolved reference: percentOf");
    expect(text).toContain("… 298 lines …");
    expect(text).toContain("BUILD FAILED");
    expect(text.split("\n").length).toBeLessThan(40);
    // a runner's «0 failed» is no failure
    expect(excerptOf("Tests: 0 failed, 12 passed").hits).toBe(0);
  });
});

describe("steering while it works", () => {
  it("«ask me when tests fail» stops at the first failure of this run; off, the project's setting again", async () => {
    const { engine, calls } = workflow([[rounding("99.89")], [rounding("99.80")], []]);
    const run = createRun(rt, "rounds");
    setChecksAsk(rt, run, true, "user:dev@example.com");
    expect(checksAskOf(rt, run.id)).toBe("every-failure");
    const first = await engine.execute(run.id, owner);
    expect(first.run.state).toBe("WAITING_HUMAN");
    expect(calls).toEqual(["implementation#1", "verify#1"]);
    setChecksAsk(rt, run, false, "user:dev@example.com");
    expect(checksAskOf(rt, run.id)).toBe("same-failure");
  });

  it("«stop after this step» parks when the step ends, before the next; taken back, nothing stops", async () => {
    const { engine, calls } = workflow([[]]);
    const run = createRun(rt, "rounds");
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 1 });
    requestPauseAfter(rt, rt.runs.get(run.id) as never, "user:dev@example.com");
    expect(pauseAfterRequested(rt, run.id)).toMatchObject({
      step: "implementation",
      iteration: 1,
      by: "dev@example.com",
    });
    const paused = await engine.execute(run.id, owner);
    expect(calls).toEqual(["implementation#1"]);
    expect(paused.run.state).toBe("SUSPENDED");
    expect(paused.run.stateReason).toContain("paused after implementation by dev@example.com");
    // honoured: going on, it does not stop again
    expect(pauseAfterRequested(rt, run.id)).toBeUndefined();
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");

    const other = workflow([[]]);
    const r2 = createRun(rt, "rounds");
    rt.runs.update(r2.id, { currentStep: "implementation", currentIteration: 1 });
    requestPauseAfter(rt, rt.runs.get(r2.id) as never, "user:dev@example.com");
    requestPauseAfter(rt, rt.runs.get(r2.id) as never, "user:dev@example.com", true);
    expect((await other.engine.execute(r2.id, owner)).run.state).toBe("COMPLETED");
  });
});
