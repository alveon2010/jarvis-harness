import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainRun } from "../../src/app/explain.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import {
  editableDir,
  editableFile,
  HUMAN_EDIT_EVENT,
  HUMAN_EDIT_REJECTED_EVENT,
  syncEditable,
} from "../../src/artifacts/editable.ts";
import type { Actor } from "../../src/core/domain/actor.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { ACTOR, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

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

const REVIEWER: Actor = { kind: "user", id: "reviewer@corp", verified: false };

function runIn(path: string, workflow = "gate"): Run {
  return rt.runs.create({
    task: "ABC-42",
    workflow,
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: path, path, baseRef: "HEAD" },
    dataClass: rt.loaded.config.dataClass,
  });
}

const SPEC = JSON.stringify({ summary: "orders-api returns 404 for a missing order" }, null, 2);

function putSpec(run: Run, content = SPEC) {
  return rt.artifacts.put({
    runId: run.id,
    type: "spec",
    name: "spec.json",
    content,
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "spec" },
    stepId: "spec",
    iteration: 1,
  });
}

describe("syncEditable (ADR-0005 §3)", () => {
  it("writes the document into .jarvis/runs/<run>/, kept out of git", () => {
    const run = runIn(sb.project);
    putSpec(run);
    const sync = syncEditable(rt, run);
    expect(sync.edited).toEqual([]);
    const file = editableFile(run, { type: "spec", name: "spec.json" });
    expect(file).toBe(join(sb.project, ".jarvis", "runs", run.id, "spec.json"));
    expect(readFileSync(file, "utf8")).toBe(SPEC);
    expect(readFileSync(join(editableDir(run), ".gitignore"), "utf8")).toBe("*\n");
    // research is not edited as a file
    rt.artifacts.put({
      runId: run.id,
      type: "research",
      name: "research.json",
      content: "{}",
      provenance: { kind: "agent", agentId: "research" },
    });
    syncEditable(rt, run);
    expect(existsSync(join(editableDir(run), "research.json"))).toBe(false);
  });

  it("a changed file becomes the next version, the person's, with a diff and an event", () => {
    const run = runIn(sb.project);
    const v1 = putSpec(run);
    syncEditable(rt, run);
    const file = editableFile(run, v1);
    const edited = JSON.stringify({ summary: "orders-api returns 404 and an error code" }, null, 2);
    writeFileSync(file, edited);

    const sync = syncEditable(rt, run, REVIEWER);
    expect(sync.edited).toHaveLength(1);
    const v2 = rt.artifacts.latest(v1.artifactId);
    expect(v2).toMatchObject({
      version: 2,
      parentVersion: 1,
      provenance: { kind: "human", actor: REVIEWER },
    });
    expect(rt.artifacts.text(v2 as NonNullable<typeof v2>)).toBe(edited);
    const diffRef = v2?.provenance.kind === "human" ? v2.provenance.diffRef : undefined;
    expect(diffRef && rt.blobs.getText(diffRef)).toContain(
      '+  "summary": "orders-api returns 404 and an error code"',
    );
    const events = rt.events.list({ runId: run.id, kind: HUMAN_EDIT_EVENT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "user:reviewer@corp",
      payload: { artifactId: v1.artifactId, version: 2, parentVersion: 1, type: "spec", file: "spec.json" },
    });

    // the same file again: nothing new
    expect(syncEditable(rt, run).edited).toEqual([]);
    expect(rt.artifacts.latest(v1.artifactId)?.version).toBe(2);
  });

  it("an editor that only re-indents or adds the final newline changed nothing", () => {
    const run = runIn(sb.project);
    const v1 = putSpec(run);
    syncEditable(rt, run);
    writeFileSync(editableFile(run, v1), `${JSON.stringify(JSON.parse(SPEC), null, 4)}\n`);
    expect(syncEditable(rt, run).edited).toEqual([]);
    expect(rt.artifacts.latest(v1.artifactId)?.version).toBe(1);
    // the file is written back as the version it is
    expect(readFileSync(editableFile(run, v1), "utf8")).toBe(SPEC);
  });

  it("broken JSON is not taken: the file stays as the person left it, announced once", () => {
    const run = runIn(sb.project);
    const v1 = putSpec(run);
    syncEditable(rt, run);
    const file = editableFile(run, v1);
    writeFileSync(file, '{ "summary": "half');
    const first = syncEditable(rt, run);
    expect(first.rejected[0]?.reason).toMatch(/not valid JSON/);
    syncEditable(rt, run);
    expect(rt.artifacts.latest(v1.artifactId)?.version).toBe(1);
    expect(readFileSync(file, "utf8")).toBe('{ "summary": "half');
    expect(rt.events.list({ runId: run.id, kind: HUMAN_EDIT_REJECTED_EVENT })).toHaveLength(1);
    // fixed: taken
    writeFileSync(file, '{ "summary": "whole" }');
    expect(syncEditable(rt, run).edited).toHaveLength(1);
  });

  it("an edit of a version an agent replaced meanwhile is kept aside, not taken over the new one", () => {
    const run = runIn(sb.project);
    const v1 = putSpec(run);
    syncEditable(rt, run);
    const file = editableFile(run, v1);
    writeFileSync(file, '{ "summary": "mine" }');
    putSpec(run, '{ "summary": "the agent again" }');
    const sync = syncEditable(rt, run);
    expect(sync.edited).toEqual([]);
    expect(sync.rejected[0]?.reason).toMatch(/moved on to @2/);
    expect(readFileSync(`${file}.conflict`, "utf8")).toBe('{ "summary": "mine" }');
    expect(readFileSync(file, "utf8")).toBe('{ "summary": "the agent again" }');
    expect(rt.artifacts.latest(v1.artifactId)?.provenance.kind).toBe("agent");
  });

  it("does nothing where the run's workspace is gone", () => {
    const run = runIn(join(sb.root, "removed-worktree"));
    putSpec(run);
    expect(syncEditable(rt, run)).toEqual({ edited: [], rejected: [] });
    expect(existsSync(join(sb.root, "removed-worktree"))).toBe(false);
  });
});

describe("the engine takes a person's edit (ADR-0005 §3, §5)", () => {
  it("at a gate: the edit is the version that waits; the next step reads it; explain names the person", async () => {
    const wf = workflowOf({
      name: "gate",
      entry: "spec",
      steps: [
        {
          id: "spec",
          kind: "agentic",
          agent: "spec",
          outputs: ["spec"],
          transitions: { onSuccess: "approve" },
        },
        { id: "approve", kind: "approval", artifactType: "spec", transitions: { onSuccess: "plan" } },
        { id: "plan", kind: "agentic", agent: "plan", inputs: ["spec"], transitions: { onSuccess: "DONE" } },
      ],
    });
    let planSaw = "";
    const engine = engineFor(rt, [wf], {
      spec: async (ctx) => {
        const a = putSpec(ctx.run);
        return { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
      },
      plan: async (ctx) => {
        const [id, version] = (ctx.inputs[0] ?? "").split("@");
        const a = ctx.runtime.artifacts.require(id as string, Number(version));
        planSaw = `${a.version}:${ctx.runtime.artifacts.text(a)}`;
        return { status: "success" };
      },
    });
    const run = runIn(sb.project);
    const parked = await engine.execute(run.id, { owner: "cli:t" });
    expect(parked.run.state).toBe("WAITING_HUMAN");
    const v1 = rt.artifacts.find(run.id, "spec", "spec.json");
    if (!v1) throw new Error("spec");
    const file = editableFile(run, v1);
    expect(readFileSync(file, "utf8")).toBe(SPEC);

    // approved as the agent wrote it, then edited in the file: the approval does not cover the edit
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: v1.artifactId,
      version: 1,
      actor: ACTOR,
      decision: "approve",
    });
    writeFileSync(file, '{ "summary": "orders-api: 404 with code ABC-42" }');
    const again = await engine.execute(run.id, { owner: "cli:t" });
    expect(again.run.state).toBe("WAITING_HUMAN");
    expect(again.run.stateReason).toContain("spec.json@2");
    const v2 = rt.artifacts.latest(v1.artifactId);
    expect(v2?.provenance).toMatchObject({ kind: "human", actor: ACTOR });

    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: v1.artifactId,
      version: 2,
      actor: ACTOR,
      decision: "approve",
    });
    const done = await engine.execute(run.id, { owner: "cli:t" });
    expect(done.run.state).toBe("COMPLETED");
    expect(planSaw).toBe('2:{ "summary": "orders-api: 404 with code ABC-42" }');
    expect(rt.history.list(run.id).find((h) => h.stepId === "plan")?.inputs).toEqual([`${v1.artifactId}@2`]);

    const explained = explainRun(rt, rt.runs.require(run.id)).artifacts.find((a) => a.type === "spec");
    expect(explained?.editedBy).toMatchObject({ actor: "user:me@corp", from: 1 });
  });
});
