import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { resolveClarification } from "../../src/interaction/clarify.ts";
import { REQUIREMENT_CORRECTION, requirementCorrectionsOf } from "../../src/interaction/corrections.ts";
import { afterAnalysis, seedComments } from "../../src/interaction/review/lifecycle.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0019 §4, §5: what a person corrects in the requirements is an artifact the next steps take. */
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

function withRequirements() {
  const run = createRun(rt, "sdd", "ABC-42 payments retry");
  const requirements = rt.artifacts.put({
    runId: run.id,
    type: "requirements",
    name: "requirements.json",
    content: JSON.stringify({ requirements: [{ id: "R2", text: "Every rejected payment is retried" }] }),
    provenance: { kind: "agent", agentId: "requirements" },
    stepId: "requirements",
    iteration: 1,
  });
  return { run, requirementsRef: `${requirements.artifactId}@${requirements.version}` };
}

describe("requirement-correction", () => {
  it("a clarification that changes requirements leaves one, against the latest requirements", () => {
    const { run, requirementsRef } = withRequirements();
    const thread = rt.interactions.open({
      runId: run.id,
      kind: "clarification",
      stepId: "spec",
      iteration: 1,
      openedBy: "agent:specification",
      message: { role: "jarvis", actor: "agent:specification", text: "Retry which rejections?" },
    });
    const { artifactRef } = resolveClarification(
      rt,
      run,
      thread,
      {
        rule: "Retry only REJECTED_TEMPORARY",
        requirementCorrections: ["R2: only temporary rejections are retried"],
        assumptions: [],
      },
      "dev@example.com",
    );
    const [c] = requirementCorrectionsOf(rt, run.id);
    expect(c?.doc).toEqual({
      from: "clarification",
      source: artifactRef,
      basedOn: requirementsRef,
      corrections: ["R2: only temporary rejections are retried"],
      rule: "Retry only REJECTED_TEMPORARY",
      by: "dev@example.com",
    });
    expect(c?.artifact.provenance).toMatchObject({ kind: "human", actor: { id: "dev@example.com" } });
    expect(c?.artifact.sourceRefs).toEqual([artifactRef, requirementsRef]);

    // a rule that corrects nothing leaves none
    const other = rt.interactions.open({
      runId: run.id,
      kind: "clarification",
      stepId: "spec",
      iteration: 1,
      openedBy: "agent:specification",
    });
    resolveClarification(rt, run, other, { rule: "x", requirementCorrections: [], assumptions: [] }, "dev");
    expect(rt.artifacts.listLatest(run.id, REQUIREMENT_CORRECTION)).toHaveLength(1);
  });

  it("a review comment classed REQUIREMENT_CORRECTION leaves one with the reviewer's words", () => {
    const { run, requirementsRef } = withRequirements();
    const collected = [
      { id: "R-1", file: "src/retry.ts", line: 12, text: "Retry only REJECTED_TEMPORARY" },
      { id: "R-2", file: "src/retry.ts", line: 20, text: "Rename this" },
    ];
    rt.interactions.open({
      runId: run.id,
      kind: "review",
      stepId: "approve-impl",
      iteration: 1,
      contentRef: "art_pkg@1",
      openedBy: "reviewer@example.com",
      meta: { comments: seedComments(rt, run.id, collected, "reviewer@example.com") },
    });
    afterAnalysis(rt, run, {
      comments: [
        { id: "R-1", class: "REQUIREMENT_CORRECTION", action: "back to requirements" },
        { id: "R-2", class: "CODE" },
      ],
    });
    const [c] = requirementCorrectionsOf(rt, run.id);
    expect(c?.doc).toMatchObject({
      from: "review",
      source: "art_pkg@1",
      basedOn: requirementsRef,
      by: "reviewer@example.com",
      corrections: ["R-1 src/retry.ts:12 — Retry only REJECTED_TEMPORARY (back to requirements)"],
    });
  });

  it("the requirements and spec steps of the built-in workflows take it as input", async () => {
    for (const name of ["sdd", "spec"]) {
      const wf = loadWorkflows().get(name);
      if (!wf) continue;
      for (const id of ["requirements", "spec"])
        expect(wf.steps.find((s) => s.id === id)?.inputs, `${name}/${id}`).toContain(REQUIREMENT_CORRECTION);
    }
    const wf = workflowOf({
      name: "redo",
      entry: "requirements",
      steps: [
        {
          id: "requirements",
          kind: "agentic",
          agent: "requirements",
          inputs: ["requirements", REQUIREMENT_CORRECTION],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    let inputs: readonly string[] = [];
    const engine = engineFor(rt, [wf], {
      requirements: async (ctx) => {
        inputs = ctx.inputs;
        return writeArtifact(ctx, "requirements", "{}");
      },
    });
    const run = createRun(rt, "redo");
    const thread = rt.interactions.open({
      runId: run.id,
      kind: "clarification",
      stepId: "requirements",
      iteration: 1,
      openedBy: ACTOR.id,
    });
    resolveClarification(
      rt,
      run,
      thread,
      { rule: "r", requirementCorrections: ["R1"], assumptions: [] },
      "dev",
    );
    await engine.execute(run.id, { owner: "cli:test:1" });
    const correction = rt.artifacts.listLatest(run.id, REQUIREMENT_CORRECTION)[0];
    expect(inputs).toContain(`${correction?.artifactId}@${correction?.version}`);
  });
});
