import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidatesOf, promoteCandidate, proposeGlossaryCandidates } from "../../src/app/candidates.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { parseGlossary } from "../../src/knowledge/retrieval/glossary.ts";
import { proposeGlossary, termLinksIn } from "../../src/knowledge/retrieval/termLinks.ts";
import { ACTOR, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;

const GLOSSARY = `# Glossary

| term | synonyms | symbols/modules | sources | updated |
| --- | --- | --- | --- | --- |
| заявка | application | \`Application\` | ABC-1 | 2026-10-01 |
`;

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  sb.write("project/.jarvis/knowledge/glossary.md", GLOSSARY);
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const glossaryFile = () => join(sb.project, ".jarvis", "knowledge", "glossary.md");
const newRun = (task = "ABC-42") =>
  rt.runs.create({
    task,
    workflow: "links",
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: rt.loaded.config.dataClass,
  });
const research = (runId: string, termLinks: unknown) =>
  rt.artifacts.put({
    runId,
    type: "research",
    name: "research.json",
    content: JSON.stringify({ summary: "s", findings: [], termLinks }),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "research" },
    stepId: "research",
  });

describe("glossary proposals from term links (ADR-0015 §3)", () => {
  it("reads links and proposes only what the glossary lacks, a person's links first", () => {
    expect(termLinksIn("not json")).toEqual([]);
    expect(
      termLinksIn(
        JSON.stringify({
          termLinks: [{ term: " заявка ", symbols: ["`ApplicationForm`", ""] }, { term: "x" }],
        }),
      ),
    ).toEqual([{ term: "заявка", symbols: ["ApplicationForm"], sources: [] }]);

    const glossary = parseGlossary(GLOSSARY);
    const proposals = proposeGlossary(
      [
        {
          ref: "art_r@1",
          human: false,
          termLinks: [
            { term: "Application", symbols: ["Application", "ApplicationForm"] }, // a synonym: the known term
            { term: "повторная регистрация", symbols: ["canRestartOnboarding"], sources: ["ABC-42"] },
            { term: "возврат", symbols: ["refundTwice"] },
          ],
        },
        // a person corrected the term's symbols in impact: only theirs count for it
        { ref: "art_i@2", human: true, termLinks: [{ term: "возврат", symbols: ["refundOnce"] }] },
      ],
      glossary,
    );
    expect(proposals).toEqual([
      { term: "возврат", symbols: ["refundOnce"], sources: [], from: ["art_i@2"], existing: false },
      { term: "заявка", symbols: ["ApplicationForm"], sources: [], from: ["art_r@1"], existing: true },
      {
        term: "повторная регистрация",
        symbols: ["canRestartOnboarding"],
        sources: ["ABC-42"],
        from: ["art_r@1"],
        existing: false,
      },
    ]);
    // everything known already: nothing to propose
    expect(
      proposeGlossary(
        [{ ref: "a@1", human: false, termLinks: [{ term: "заявка", symbols: ["Application"] }] }],
        glossary,
      ),
    ).toEqual([]);
  });

  it("a completed run proposes candidates once; promoting writes or extends the glossary row", async () => {
    const wf = workflowOf({
      name: "links",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const engine = engineFor(rt, [wf], {
      research: async (ctx) => {
        const a = research(ctx.run.id, [
          {
            term: "повторная регистрация",
            symbols: ["canRestartOnboarding", "src/onboarding/"],
            sources: ["ABC-42"],
          },
          { term: "заявка", symbols: ["Application", "ApplicationForm"] },
        ]);
        return { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
      },
    });
    const run = newRun();
    expect((await engine.execute(run.id, { owner: "cli:test:1" })).run.state).toBe("COMPLETED");
    const open = candidatesOf(rt).filter((c) => c.doc.kind === "glossary");
    expect(open.map((c) => [c.doc.glossary?.term, c.doc.glossary?.symbols])).toEqual([
      ["заявка", ["ApplicationForm"]],
      ["повторная регистрация", ["canRestartOnboarding", "src/onboarding/"]],
    ]);
    expect(rt.events.list({ runId: run.id }).map((e) => e.kind)).toContain("glossary.proposed");

    // the same links again (another run): proposed already, not again
    const second = newRun("ABC-43");
    research(second.id, [{ term: "заявка", symbols: ["ApplicationForm"] }]);
    expect(proposeGlossaryCandidates(rt, second)).toEqual([]);

    for (const c of open)
      promoteCandidate(rt, { root: sb.project, candidate: c, actor: ACTOR, channel: "cli" });
    const after = parseGlossary(readFileSync(glossaryFile(), "utf8"));
    expect(after.find((e) => e.term === "заявка")?.symbols).toEqual(["Application", "ApplicationForm"]);
    expect(after.find((e) => e.term === "повторная регистрация")).toMatchObject({
      symbols: ["canRestartOnboarding", "src/onboarding/"],
      sources: ["ABC-42"],
    });
    expect(
      candidatesOf(rt)
        .filter((c) => c.doc.kind === "glossary")
        .map((c) => c.decision),
    ).toEqual(["approve", "approve"]);
  });
});
