import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import {
  CANDIDATE_EVENT,
  candidateReasons,
  dismissEvalCandidate,
  evalCandidates,
  reasonLine,
} from "../../src/evals/candidates.ts";
import { inLang } from "../../src/ui/i18n.ts";
import { evalReasonText } from "../../src/ui/pages.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0012 §3: a run that ends accepted and on which a person corrected Jarvis is noted as a case candidate. */
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

const owner = { owner: "cli:test:1" };
const wf = workflowOf({
  name: "mini-sdd",
  entry: "spec",
  steps: [
    {
      id: "spec",
      kind: "agentic",
      agent: "spec",
      outputs: ["spec"],
      transitions: { onSuccess: "approve-spec" },
    },
    {
      id: "approve-spec",
      kind: "approval",
      artifactType: "spec",
      transitions: {
        onSuccess: "implementation",
        onOutcome: { request_changes: { to: "spec", maxIterations: 2 } },
      },
    },
    {
      id: "implementation",
      kind: "agentic",
      agent: "implementation",
      outputs: ["implementation"],
      transitions: { onSuccess: "approve-impl" },
    },
    {
      id: "approve-impl",
      kind: "approval",
      artifactType: "implementation",
      transitions: { onSuccess: "DONE" },
    },
  ],
});
const agents = {
  spec: async (ctx: Parameters<typeof writeArtifact>[0]) =>
    writeArtifact(ctx, "spec", `# spec ${ctx.iteration}`),
  implementation: async (ctx: Parameters<typeof writeArtifact>[0]) =>
    writeArtifact(ctx, "implementation", "changed src/orders.ts"),
};

function decide(runId: string, type: string, decision: "approve" | "request_changes") {
  const latest = rt.artifacts.listLatest(runId, type)[0];
  if (!latest) throw new Error(type);
  rt.artifacts.approve({
    runId,
    stepId: `approve-${type === "spec" ? "spec" : "impl"}`,
    artifactId: latest.artifactId,
    version: latest.version,
    actor: ACTOR,
    decision,
    ...(decision === "request_changes" ? { comment: "cover the retry" } : {}),
  });
}

describe("eval case candidates", () => {
  it("notes a run sent back at a gate, not one that went straight through; dismiss takes it off", async () => {
    const engine = engineFor(rt, [wf], agents);

    // sent back once at the spec gate, then accepted
    const taught = createRun(rt, "mini-sdd", "ABC-42 retry the payment");
    await engine.execute(taught.id, owner);
    decide(taught.id, "spec", "request_changes");
    await engine.execute(taught.id, owner);
    decide(taught.id, "spec", "approve");
    await engine.execute(taught.id, owner);
    decide(taught.id, "implementation", "approve");
    expect((await engine.execute(taught.id, owner)).run.state).toBe("COMPLETED");

    // straight through
    const plain = createRun(rt, "mini-sdd", "ABC-43 rename a field");
    await engine.execute(plain.id, owner);
    decide(plain.id, "spec", "approve");
    await engine.execute(plain.id, owner);
    decide(plain.id, "implementation", "approve");
    expect((await engine.execute(plain.id, owner)).run.state).toBe("COMPLETED");

    // a person edited the spec before approving it
    const edited = createRun(rt, "mini-sdd", "ABC-44 orders-api limit");
    await engine.execute(edited.id, owner);
    const spec = rt.artifacts.listLatest(edited.id, "spec")[0];
    if (!spec) throw new Error("spec");
    rt.artifacts.recordHumanEdit(spec.artifactId, "# spec, with the limit", ACTOR);
    decide(edited.id, "spec", "approve");
    await engine.execute(edited.id, owner);
    decide(edited.id, "implementation", "approve");
    expect((await engine.execute(edited.id, owner)).run.state).toBe("COMPLETED");

    const list = evalCandidates(rt);
    expect(list.map((c) => c.runId)).toEqual([edited.id, taught.id]);
    // the back edge the send-back took is not a second reason
    expect(list[1]?.reasons).toEqual([{ kind: "sent-back", type: "spec", times: 1 }]);
    expect(list[0]?.reasons).toEqual([{ kind: "edited", type: "spec", versions: [2] }]);
    expect(candidateReasons(rt, rt.runs.require(plain.id))).toBeUndefined();
    expect(rt.events.list({ runId: plain.id, kind: CANDIDATE_EVENT })).toHaveLength(0);
    expect(list[1]?.reasons.map(reasonLine)).toEqual(["spec sent back 1×"]);
    expect(inLang("ru", () => evalReasonText({ kind: "sent-back", type: "spec", times: 2 }))).toBe(
      "spec возвращали на доработку 2 раза",
    );

    dismissEvalCandidate(rt, taught.id, ACTOR.id);
    expect(evalCandidates(rt).map((c) => c.runId)).toEqual([edited.id]);
  });

  it("an unaccepted run or the evals' own run is no candidate", async () => {
    const engine = engineFor(rt, [wf], agents);
    const run = createRun(rt, "mini-sdd", "ABC-45");
    await engine.execute(run.id, owner);
    decide(run.id, "spec", "request_changes");
    await engine.execute(run.id, owner);
    // waiting at the gate again: not COMPLETED
    expect(candidateReasons(rt, rt.runs.require(run.id))).toBeUndefined();

    const own = rt.runs.create({
      task: "ABC-46",
      workflow: "mini-sdd",
      owner: { kind: "user", id: "evals@jarvis", verified: false },
      workspace: { mode: "cwd", repoRoot: "/r", path: "/r", baseRef: "HEAD" },
      dataClass: rt.loaded.config.dataClass,
    });
    await engine.execute(own.id, owner);
    decide(own.id, "spec", "request_changes");
    await engine.execute(own.id, owner);
    decide(own.id, "spec", "approve");
    await engine.execute(own.id, owner);
    decide(own.id, "implementation", "approve");
    expect((await engine.execute(own.id, owner)).run.state).toBe("COMPLETED");
    expect(evalCandidates(rt)).toEqual([]);
  });
});
