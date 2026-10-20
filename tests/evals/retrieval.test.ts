import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { diffRetrieval, refMatches, scoreCase, summarize } from "../../src/evals/retrieval.ts";
import type { Evidence } from "../../src/knowledge/retrieval/retriever.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;

/** A tiny neutral labelled set (ADR-0015 §6): a business term in Russian, plain English words, a standard. */
const CASES = `cases:
  - id: restart-after-rejection
    query: повторная регистрация после отказа
    expected: [src/onboarding.ts, knowledge:onboarding]
  - id: refund-once
    query: refund the ledger entry once
    expected: [src/payments/refund.ts, standard:no-double-refund]
  - id: order-dispatch
    query: orders immutable after dispatch
    expected: [knowledge:orders.md]
`;

const ev = (ref: string): Evidence => ({
  sourceId: ref,
  ref,
  kind: "code",
  title: ref,
  score: 1,
  retrievalPath: [{ index: "lexical", rank: 1 }],
});

beforeEach(() => {
  sb = sandbox();
  rmSync(join(sb.project, ".git"), { recursive: true, force: true });
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/knowledge/glossary.md",
    "| термин | синонимы | символы/модули | источники | обновлено |\n|---|---|---|---|---|\n| повторная регистрация | restart onboarding | canRestartOnboarding, OnboardingService | ABC-42 | 2026-10-01 |\n",
  );
  sb.write(
    "project/.jarvis/knowledge/onboarding.md",
    "# Onboarding\n\nOnboardingService owns the flow; canRestartOnboarding decides a second attempt.\n",
  );
  sb.write("project/.jarvis/knowledge/orders.md", "# Orders\n\nOrders are immutable after dispatch.\n");
  sb.write(
    "project/.jarvis/standards/no-double-refund.md",
    "---\nid: no-double-refund\ntitle: Refund once\n---\nA refund is idempotent per ledger entry.\n",
  );
  sb.write(
    "project/src/onboarding.ts",
    "export function canRestartOnboarding(app: { restarts: number }): boolean {\n  return app.restarts === 0;\n}\n",
  );
  sb.write(
    "project/src/payments/refund.ts",
    "export function refundOnce(entry: string) {\n  return ledger.refund(entry);\n}\n",
  );
  sb.write("project/evals/retrieval/cases.yaml", CASES);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ])
    execFileSync("git", args, { cwd: sb.project, env });
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[]) {
  let out = "";
  const code = await run(["node", "jarvis", ...args], {
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
    },
    context: { cwd: sb.project, homeDir: sb.home, env: {} },
  });
  return { code, out };
}

describe("retrieval metrics (ADR-0015 §6)", () => {
  it("matches refs by unit, file and line", () => {
    expect(refMatches("src/a.ts:10-40", "src/a.ts")).toBe(true);
    expect(refMatches("src/a.ts:10-40", "src/a.ts:12")).toBe(true);
    expect(refMatches("src/a.ts:10-40", "src/a.ts:41")).toBe(false);
    expect(refMatches("src/ab.ts:1-2", "src/a")).toBe(false);
    expect(refMatches("knowledge:onboarding.md", "knowledge:onboarding")).toBe(true);
    expect(refMatches("standard:no-double-refund@1", "standard:no-double-refund")).toBe(true);
  });

  it("scores Recall@k, reciprocal rank, irrelevant share and tokens", () => {
    const c = { id: "c", query: "q", expected: ["src/a.ts", "knowledge:b"] };
    const refs = ["x:1-2", "src/a.ts:1-9", "y", "z", "w", "v", "knowledge:b.md"];
    const s = scoreCase(c, { evidence: refs.map(ev), expansions: [] }, new Map([["src/a.ts:1-9", 400]]));
    expect(s).toMatchObject({
      recallAt5: 0.5,
      recallAt10: 1,
      reciprocalRank: 0.5,
      irrelevant: 0.7143,
      tokens: 100,
      missed: [],
    });
    const none = scoreCase(c, { evidence: [], expansions: [] });
    expect(none).toMatchObject({ recallAt10: 0, reciprocalRank: 0, irrelevant: 0, missed: c.expected });
    const sum = summarize([s, none]);
    expect(sum).toMatchObject({ cases: 2, recallAt5: 0.25, recallAt10: 0.5, mrr: 0.25 });
    expect(sum.gate).toEqual({ target: 0.9, passed: false });
  });

  it("diffs against the baseline: a drop in recall or a rise in cost regresses", () => {
    const base = summarize([
      { ...scoreCase({ id: "a", query: "q", expected: ["r"] }, { evidence: [ev("r")], expansions: [] }) },
    ]);
    const worse = { ...base, recallAt10: 0.5, retrievedTokens: base.retrievedTokens };
    expect(diffRetrieval({ summary: base }, { summary: base }).ok).toBe(true);
    const d = diffRetrieval({ summary: base }, { summary: worse });
    expect(d.ok).toBe(false);
    expect(d.regressions).toEqual(["recallAt10: 1 → 0.5"]);
    expect(
      diffRetrieval({ summary: base }, { summary: { ...base, retrievedTokens: 1000 } }).regressions,
    ).toEqual([`retrievedTokens: ${base.retrievedTokens} → 1000`]);
  });

  it("jarvis knowledge eval runs the cases, pins a baseline and catches a regression", async () => {
    const first = await jarvis(["knowledge", "eval", "--baseline"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("retrieval: 3 case(s), lexical + glossary");
    expect(first.out).toMatch(/restart-after-rejection\s+100%\s+100%\s+1\.00/);
    expect(first.out).toContain("summary: Recall@5 100%, Recall@10 100%, MRR 1.00");
    expect(first.out).toContain("gate (ADR-0015 §6): Recall@10 ≥ 0.9");
    const baseline = join(sb.project, "evals", "baseline", "retrieval.json");
    expect(existsSync(baseline)).toBe(true);
    expect(JSON.parse(readFileSync(baseline, "utf8")).summary.recallAt10).toBe(1);

    const same = await jarvis(["knowledge", "eval"]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("no regression beyond tolerance");

    // without the glossary the Russian query misses the English code: what the glossary is for
    const bare = await jarvis(["knowledge", "eval", "--no-glossary"]);
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("lexical (no glossary)");
    expect(bare.out).toContain("missed: src/onboarding.ts, knowledge:onboarding");
    expect(bare.out).toContain("REGRESSION: recallAt5");

    const missing = await jarvis(["knowledge", "eval", "--cases", "nope.yaml"]);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("no retrieval cases at");
  });
});
