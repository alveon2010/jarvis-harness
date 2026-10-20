import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEffect, unresolvedEffectOf } from "../../src/app/effects.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { UnresolvedEffectError } from "../../src/orchestration/effects.ts";
import { waitCardOf } from "../../src/ui/model.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0002 §2: a run waiting on an effect nobody can verify has a way forward. */
let sb: Sandbox;
let rt: Runtime;

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const comment = { issue: "ABC-42", body: "the spec is approved" };

/** A run whose comment was sent and then the process died: the journal cannot tell. */
async function stuck() {
  const wf = workflowOf({
    name: "post",
    entry: "post",
    steps: [{ id: "post", kind: "agentic", agent: "post", transitions: { onSuccess: "DONE" } }],
  });
  let tries = 0;
  const engine = engineFor(rt, [wf], {
    post: async (ctx) => {
      tries += 1;
      const input = {
        runId: ctx.run.id,
        stepId: "post",
        iteration: 1,
        capability: "jira.comment",
        args: comment,
        seq: 1,
        leaseEpoch: 1,
      };
      const begun = rt.effects.begin(input);
      if (begun.status === "done") return { status: "success" };
      if (begun.status === "new" && tries === 1) {
        // sent, and nothing recorded after: next time its outcome is unknown
        rt.effects.begin(input);
        throw new UnresolvedEffectError(rt.effects.byKey(begun.record.key) ?? begun.record);
      }
      if (begun.status === "unknown") throw new UnresolvedEffectError(begun.record);
      rt.effects.complete(begun.record.id, { id: "c-2" });
      return { status: "success" };
    },
  });
  const run = createRun(rt, "post");
  const parked = await engine.execute(run.id, { owner: "cli:test:1" });
  return { engine, run: parked.run, tries: () => tries };
}

describe("an effect whose outcome is unknown", () => {
  it("parks the run with what was tried and where to look", async () => {
    const { run } = await stuck();
    expect(run.state).toBe("WAITING_HUMAN");
    expect(run.waitingFor?.kind).toBe("effect");
    const doc = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(run.id, "effect-unresolved")[0] as never),
    ) as {
      capability: string;
      args: unknown;
      marker: string;
    };
    expect(doc.capability).toBe("jira.comment");
    expect(doc.args).toEqual(comment);
    expect(doc.marker).toMatch(/^jarvis:run=run_\w+ effect=[0-9a-f]{12}$/);
    const card = await waitCardOf(rt, run, sb.home);
    expect(card).toMatchObject({
      kind: "effect",
      capability: "jira.comment",
      step: "post",
      marker: doc.marker,
    });
  });

  it("«it happened»: recorded done, the run goes on without doing it again", async () => {
    const { engine, run, tries } = await stuck();
    resolveEffect(rt, run, "happened", ACTOR, "cli", "the comment is there");
    expect(unresolvedEffectOf(rt, rt.runs.get(run.id) ?? run)).toBeUndefined();
    const done = await engine.execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(tries()).toBe(2);
    expect(rt.events.list({ runId: run.id, kind: "effect.resolved" })[0]?.payload).toMatchObject({
      decision: "happened",
      note: "the comment is there",
    });
  });

  it("«it did not»: the run does it again", async () => {
    const { engine, run } = await stuck();
    resolveEffect(rt, run, "again", ACTOR, "ui");
    const done = await engine.execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(rt.effects.byRun(run.id).map((e) => e.status)).toEqual(["done"]);
  });
});
