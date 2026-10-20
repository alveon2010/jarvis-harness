import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCandidate,
  CANDIDATES_WORKFLOW,
  CandidateInvalid,
  candidatesOf,
  promoteCandidate,
  rejectCandidate,
} from "../../src/app/candidates.ts";
import { findingKey, normalizeFinding, proposeRepeatedFindings } from "../../src/app/repeatedFindings.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Candidates that no agent proposed: by a person's hand, and from a finding review keeps repeating. */
let sb: Sandbox;
let rt: Runtime;

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  rt = await testRuntime(sb);
});

afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

describe("a candidate proposed by hand", () => {
  it("lives in the repository's candidates run and is promoted like any other", () => {
    const c = addCandidate(rt, {
      root: sb.project,
      actor: ACTOR,
      kind: "standard",
      title: "Money in minor units",
      text: "Amounts are integers in minor units, never floats.",
      paths: ["src/payments/**"],
      evidence: ["src/payments/charge.ts:12"],
    });
    expect(c).toMatchObject({ name: "money-in-minor-units", files: ["src/payments/charge.ts"] });
    expect(c.doc).toMatchObject({ kind: "standard", rationale: "Proposed by me@corp", status: "proposed" });
    expect(c.artifact.provenance).toMatchObject({ kind: "human", actor: { id: "me@corp" } });
    const home = rt.runs.require(c.artifact.runId);
    expect(home).toMatchObject({ workflow: CANDIDATES_WORKFLOW, state: "COMPLETED" });

    // a second one goes to the same run
    const k = addCandidate(rt, {
      root: sb.project,
      actor: ACTOR,
      kind: "knowledge",
      title: "Refunds go through the ledger",
      text: "Every refund is a ledger entry.",
    });
    expect(k.artifact.runId).toBe(home.id);
    expect(
      rt.runs.list({ includeTerminal: true }).filter((r) => r.workflow === CANDIDATES_WORKFLOW),
    ).toHaveLength(1);

    const done = promoteCandidate(rt, { root: sb.project, candidate: c, actor: ACTOR });
    expect(done.path).toBe(".jarvis/standards/money-in-minor-units.md");
    expect(readFileSync(done.file, "utf8")).toMatch(/severity: recommended[\s\S]*never floats/);
    expect(candidatesOf(rt).map((x) => x.decision ?? "open")).toEqual(["approve", "open"]);
  });

  it("as a skill improvement names a skill there is, which promote then edits", () => {
    const base = {
      root: sb.project,
      actor: ACTOR,
      kind: "skill-improvement" as const,
      title: "Fixtures",
      text: "5. Name the fixture after the case.",
    };
    expect(() => addCandidate(rt, base)).toThrow(/needs --skill/);
    expect(() => addCandidate(rt, { ...base, skill: "nope", skills: ["unit-testing"] })).toThrow(
      CandidateInvalid,
    );
    expect(candidatesOf(rt)).toEqual([]);
    const c = addCandidate(rt, { ...base, skill: "unit-testing", skills: ["unit-testing"] });
    expect(c.doc.skill).toBe("unit-testing");
    expect(promoteCandidate(rt, { root: sb.project, candidate: c, actor: ACTOR }).skill).toMatchObject({
      id: "unit-testing",
      fromBuiltin: true,
    });
    expect(readFileSync(join(sb.project, ".jarvis/skills/unit-testing/instructions.md"), "utf8")).toContain(
      "5. Name the fixture after the case.",
    );
  });

  it("needs a title and a text", () => {
    const base = { root: sb.project, actor: ACTOR, kind: "knowledge" as const };
    expect(() => addCandidate(rt, { ...base, title: " ", text: "x" })).toThrow(/title/);
    expect(() => addCandidate(rt, { ...base, title: "x", text: "\n" })).toThrow(/text/);
  });
});

describe("normalising a finding", () => {
  it("takes the instance out: paths, lines, quoted names, numbers, filler, word order", () => {
    const a = "`OrderService.save` writes to the DbContext directly in src/orders/OrderService.ts line 42";
    const b = "Writes directly to DbContext: `PaymentService.charge` (payments/PaymentService.ts:7)";
    expect(normalizeFinding(a)).toBe("dbcontext directly writes");
    expect(findingKey(a)).toBe(findingKey(b));
    expect(findingKey("Missing `await` here")).toBeUndefined();
    expect(findingKey("Controller reads the database directly")).not.toBe(findingKey(a));
  });
});

const review = (runId: string, findings: Array<Record<string, unknown>>, version = 1) =>
  rt.artifacts.put({
    runId,
    type: "review",
    name: "review.json",
    content: JSON.stringify({ summary: "s", verdict: "fix_required", findings }),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "review" },
    stepId: "review",
    iteration: version,
  });

const DB = (file: string, line: number) => ({
  severity: "major",
  file,
  line,
  issue: `\`${file.replace(/^.*\//, "")}\` writes to the DbContext directly`,
  suggestion: "Go through the repository.",
});

describe("a finding review repeats in runs", () => {
  it("becomes one standard candidate, with the runs and places as evidence", () => {
    const one = createRun(rt, "sdd", "ABC-41");
    review(one.id, [DB("src/orders/save.ts", 10), { severity: "nit", issue: "typo" }]);
    expect(proposeRepeatedFindings(rt, one)).toEqual([]);

    const two = createRun(rt, "sdd", "ABC-42");
    review(two.id, [DB("src/payments/charge.ts", 7)]);
    expect(proposeRepeatedFindings(rt, two)).toHaveLength(1);
    const [c] = candidatesOf(rt);
    expect(c?.doc).toMatchObject({
      kind: "standard",
      title: "`charge.ts` writes to the DbContext directly",
      finding: { runs: [one.id, two.id] },
    });
    expect(c?.doc.proposal).toMatch(/^Go through the repository\./);
    expect(c?.files).toEqual(["src/orders/save.ts", "src/payments/charge.ts"]);
    expect(c?.doc.evidence?.filter((e) => e.startsWith("art_"))).toHaveLength(2);

    // the same reviews again: nothing new
    expect(proposeRepeatedFindings(rt, two)).toEqual([]);
    // a third run adds its place to the open candidate
    const three = createRun(rt, "sdd", "ABC-43");
    review(three.id, [DB("src/stock/move.ts", 3)]);
    expect(proposeRepeatedFindings(rt, three)).toHaveLength(1);
    const all = candidatesOf(rt);
    expect(all).toHaveLength(1);
    expect(all[0]?.doc.finding?.runs).toHaveLength(3);
    expect(all[0]?.doc.title).toBe(c?.doc.title);

    // decided: review repeating it does not reopen it
    rejectCandidate(rt, all[0] as (typeof all)[number], ACTOR, "not a rule here");
    const four = createRun(rt, "sdd", "ABC-44");
    review(four.id, [DB("src/cart/add.ts", 1)]);
    expect(proposeRepeatedFindings(rt, four)).toEqual([]);
    expect(candidatesOf(rt).map((x) => x.decision)).toEqual(["reject"]);
  });

  it("not within one run: the rounds of one review are one run", () => {
    const one = createRun(rt, "sdd");
    review(one.id, [DB("src/a.ts", 1)]);
    review(one.id, [DB("src/b.ts", 2)], 2);
    expect(proposeRepeatedFindings(rt, one)).toEqual([]);
  });

  it("is proposed by the engine after a review step", async () => {
    const wf = workflowOf({
      name: "rv",
      entry: "review",
      steps: [{ id: "review", kind: "agentic", agent: "review", transitions: { onSuccess: "DONE" } }],
    });
    let n = 0;
    const engine = engineFor(rt, [wf], {
      review: async (ctx) => {
        n += 1;
        const a = review(ctx.run.id, [DB(`src/m${n}.ts`, n)]);
        return { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
      },
    });
    for (const task of ["ABC-1", "ABC-2"]) {
      const run = createRun(rt, "rv", task);
      expect((await engine.execute(run.id, { owner: "cli:test:1" })).run.state).toBe("COMPLETED");
    }
    expect(candidatesOf(rt).map((c) => c.doc.kind)).toEqual(["standard"]);
  });
});
