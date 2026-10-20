import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRuntime } from "../../app/runtime.ts";
import {
  DEFAULT_CASES_FILE,
  diffRetrieval,
  loadRetrievalCases,
  type RetrievalEvalResult,
  runRetrievalEval,
} from "../../evals/retrieval.ts";
import { refreshIndex } from "../../knowledge/retrieval/service.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

export interface KnowledgeEvalOptions {
  readonly cases?: string;
  readonly glossary?: boolean;
  readonly baseline?: boolean;
  readonly tolerance?: number;
  readonly out?: string;
}

const pct = (x: number) => `${String(Math.round(x * 100)).padStart(3)}%`;

/**
 * `jarvis knowledge eval [--cases file] [--no-glossary] [--baseline] [--tolerance r]` (ADR-0015 §6):
 * refreshes the index, runs the labelled cases, prints Recall@5/@10, MRR, irrelevant ratio and
 * tokens, writes the result next to the workflow evals' (`evals/results`, `evals/baseline`) and
 * compares it with the baseline — non-zero on a regression.
 */
export async function runKnowledgeEval(ctx: CliContext, options: KnowledgeEvalOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  const casesFile = resolve(root, options.cases ?? DEFAULT_CASES_FILE);
  let cases: ReturnType<typeof loadRetrievalCases>;
  try {
    cases = loadRetrievalCases(casesFile);
  } catch (error) {
    ctx.out.error(
      `${error instanceof Error ? error.message : String(error)} (cases: [{ id, query, expected: [ref…] }])`,
    );
    throw new CliExit(EXIT.error);
  }
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const roots = knowledgeRootsOf(loaded, root);
    await refreshIndex(runtime, roots);
    const result = await runRetrievalEval(runtime, roots, cases, {
      ...(options.glossary === false ? { glossary: false } : {}),
    });
    const resultsDir = join(root, "evals", "results");
    const baselineFile = join(root, "evals", "baseline", "retrieval.json");
    const file = options.out
      ? resolve(ctx.cwd, options.out)
      : join(resultsDir, `${result.at.slice(0, 10)}-retrieval.json`);
    const previous = existsSync(baselineFile)
      ? (JSON.parse(readFileSync(baselineFile, "utf8")) as RetrievalEvalResult)
      : undefined;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    if (options.baseline) {
      mkdirSync(dirname(baselineFile), { recursive: true });
      writeFileSync(baselineFile, `${JSON.stringify(result, null, 2)}\n`);
    }
    const diff =
      previous && !options.baseline ? diffRetrieval(previous, result, options.tolerance ?? 0.05) : undefined;
    ctx.out.result({ ...result, file, ...(diff ? { baseline: previous?.at, diff } : {}) }, () => {
      const s = result.summary;
      ctx.out.line(
        `retrieval: ${s.cases} case(s), ${result.indexes.join(" + ")}${result.glossary ? " + glossary" : " (no glossary)"}`,
      );
      const w = Math.max(...result.cases.map((c) => c.id.length), 4);
      ctx.out.line(`${padEnd("case", w)}  R@5   R@10  RR    irrel  tokens`);
      for (const c of result.cases) {
        ctx.out.line(
          `${padEnd(c.id, w)}  ${pct(c.recallAt5)}  ${pct(c.recallAt10)}  ${c.reciprocalRank.toFixed(2)}  ${pct(c.irrelevant)}  ${String(c.tokens).padStart(6)}`,
        );
        if (c.missed.length > 0) ctx.out.line(`${" ".repeat(w)}  missed: ${c.missed.join(", ")}`);
      }
      ctx.out.line(
        `summary: Recall@5 ${pct(s.recallAt5).trim()}, Recall@10 ${pct(s.recallAt10).trim()}, MRR ${s.mrr.toFixed(2)}, irrelevant ${pct(s.irrelevantRatio).trim()}, ${s.retrievedTokens} tokens per query`,
      );
      ctx.out.line(
        `gate (ADR-0015 §6): Recall@10 ${s.gate.passed ? "≥" : "<"} ${s.gate.target} — ${s.gate.passed ? "lexical retrieval is enough for these cases" : "read the misses: a language gap there is the case for embeddings, a hole in FTS or the graph is not"}`,
      );
      if (options.baseline) ctx.out.line(`baseline ← ${result.at} (${baselineFile})`);
      else if (diff && previous) {
        ctx.out.line(`baseline ${previous.at}:`);
        for (const [m, d] of Object.entries(diff.deltas))
          ctx.out.line(`  ${padEnd(m, 16)} ${d >= 0 ? "+" : ""}${d}`);
        ctx.out.line(
          diff.ok ? "no regression beyond tolerance" : `REGRESSION: ${diff.regressions.join("; ")}`,
        );
      } else ctx.out.line("no baseline yet: `jarvis knowledge eval --baseline` pins this one");
      ctx.out.line(`written to ${file}`);
    });
    if (diff && !diff.ok) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
