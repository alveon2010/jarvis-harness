import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CandidateNotPromotable,
  candidatesOf,
  promoteCandidate,
  skillEditOf,
} from "../../src/app/candidates.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { loadSkills } from "../../src/knowledge/skills.ts";
import { createRun } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** A skill improvement review proposes is an edit of that skill, which agents get from the next run. */
let sb: Sandbox;
let rt: Runtime;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  rt = createRuntime(await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} }), { env: {} });
});

afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const propose = (doc: Record<string, unknown>) => {
  const run = createRun(rt, "sdd");
  rt.artifacts.put({
    runId: run.id,
    type: "candidate",
    name: "review-1-1.json",
    content: JSON.stringify({
      kind: "skill-improvement",
      title: "Run the migration check",
      rationale: "missed twice",
      ...doc,
    }),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "review" },
    stepId: "review",
  });
  return candidatesOf(rt).at(-1) as ReturnType<typeof candidatesOf>[number];
};
const promote = (c: ReturnType<typeof propose>) =>
  promoteCandidate(rt, { root: sb.project, candidate: c, actor: DEV, channel: "cli" });

describe("a skill improvement", () => {
  it("edits the project's skill: its proposal goes to the end of the instructions, the version goes up", () => {
    sb.write(
      "project/.jarvis/skills/db-migration/skill.yaml",
      "# how we change the schema\nid: db-migration\nversion: 2\nappliesTo: { kinds: [change] }\n",
    );
    sb.write("project/.jarvis/skills/db-migration/instructions.md", "1. Write the migration.\n");
    const c = propose({ skill: "db-migration", proposal: "2. Run `make migrate-check` before reporting." });
    const edit = skillEditOf(sb.project, c.doc);
    expect(edit.version).toEqual({ from: 2, to: 3 });
    const done = promote(c);
    expect(done.skill).toEqual({ id: "db-migration", from: 2, to: 3, fromBuiltin: false });
    const dir = join(sb.project, ".jarvis/skills/db-migration");
    expect(readFileSync(join(dir, "instructions.md"), "utf8")).toBe(
      "1. Write the migration.\n\n2. Run `make migrate-check` before reporting.\n",
    );
    // only the version changes in the person's manifest: the comment stays
    expect(readFileSync(join(dir, "skill.yaml"), "utf8")).toContain("# how we change the schema");
    const skill = loadSkills({ projectRoot: sb.project }).find((s) => s.id === "db-migration");
    expect(skill).toMatchObject({ version: 3 });
    expect(skill?.instructions).toContain("migrate-check");
    expect(candidatesOf(rt).at(-1)?.decision).toBe("approve");
  });

  it("of a built-in skill: the project gets its copy, which overrides the built-in from then on", () => {
    const c = propose({ skill: "unit-testing", proposal: "5. Name the fixture after the case." });
    expect(promote(c).skill).toEqual({ id: "unit-testing", from: 1, to: 2, fromBuiltin: true });
    const skill = loadSkills({ projectRoot: sb.project }).find((s) => s.id === "unit-testing");
    expect(skill).toMatchObject({ level: "project", version: 2 });
    expect(skill?.appliesTo.agents).toEqual(["test", "implementation"]);
    expect(skill?.instructions).toMatch(/Map every acceptance criterion[\s\S]*5\. Name the fixture/);
  });

  it("without its skill, or of a skill the project does not own, is not written anywhere", () => {
    expect(() => promote(propose({ proposal: "x" }))).toThrow(CandidateNotPromotable);
    expect(() => promote(propose({ skill: "from-the-team-docs", proposal: "x" }))).toThrow(
      /not one of this project's skills/,
    );
    expect(loadSkills({ projectRoot: sb.project }).filter((s) => s.level === "project")).toEqual([]);
  });
});
