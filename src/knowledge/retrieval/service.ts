import type { Runtime } from "../../app/runtime.ts";
import type { KnowledgeDoc } from "../resolver.ts";
import type { KnowledgeRoots } from "../standards.ts";
import { type CodeScan, scanCode } from "./code.ts";
import { loadGlossary } from "./glossary.ts";
import { type IndexReport, KnowledgeIndex, type UnitKind } from "./index.ts";
import { type RetrievalResult, retrieve } from "./retriever.ts";

/** Keeps the index in step with the project and the run, and ranks knowledge for a task. */
export async function refreshIndex(
  runtime: Runtime,
  roots: KnowledgeRoots,
  runId?: string,
): Promise<IndexReport> {
  const units = [
    ...KnowledgeIndex.projectUnits(roots),
    ...(runId ? KnowledgeIndex.artifactUnits(runtime, runId) : []),
  ];
  const report = await runtime.index.upsert(units, runtime.embedder);
  const code = await refreshCode(runtime, roots);
  const removed = runtime.index.prune(
    new Set([
      ...units.filter((u) => u.kind !== "artifact").map((u) => u.sourceId),
      ...(code?.keep ?? []),
      ...(code?.units.map((u) => u.sourceId) ?? []),
    ]),
  );
  if (!code) return { ...report, removed };
  return {
    indexed: report.indexed + code.report.indexed,
    unchanged: report.unchanged + code.report.unchanged + code.keep.length,
    removed,
    embedded: report.embedded,
    code: { files: code.files, changed: code.changed, skipped: code.skipped },
  };
}

/**
 * Tracked source files of the project root (ADR-0015 §2 v0.4), only those git says changed. Code
 * gets no vectors: embeddings for it wait for the §6 gate.
 */
async function refreshCode(
  runtime: Runtime,
  roots: KnowledgeRoots,
): Promise<(CodeScan & { report: IndexReport }) | undefined> {
  const config = runtime.loaded.config.knowledge.retrieval.code;
  if (!config.enabled || !roots.projectRoot) return undefined;
  const scan = await scanCode(roots.projectRoot, config, runtime.index.codeVersions(), roots.isDenied);
  // ADR-0010: a key hard-coded in a source file never reaches the index or a search snippet
  const units = scan.units.map((u) => ({ ...u, body: runtime.redactor.redact(u.body).text }));
  return { ...scan, units, report: await runtime.index.upsert(units) };
}

export async function search(
  runtime: Runtime,
  roots: KnowledgeRoots,
  query: string,
  /** `glossary: false` searches without query expansion (to measure what the glossary adds, §6). */
  options: { kinds?: readonly UnitKind[]; limit?: number; glossary?: boolean } = {},
): Promise<RetrievalResult> {
  return retrieve(runtime.index, query, {
    glossary: options.glossary === false ? [] : loadGlossary(roots.projectRoot),
    ...(runtime.embedder ? { embedder: runtime.embedder } : {}),
    ...(options.kinds ? { kinds: options.kinds } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

/**
 * ADR-0015 §2: once more knowledge documents match a task than `rankAbove`, the index decides their
 * order — retrieved ones first by fused rank, the rest after in scope order. Nothing is dropped;
 * the budget fill (ADR-0020 §3) shows the head and lists the tail as available on request.
 */
export async function rankKnowledge(
  runtime: Runtime,
  roots: KnowledgeRoots,
  docs: readonly KnowledgeDoc[],
  query: string,
): Promise<{ docs: KnowledgeDoc[]; result?: RetrievalResult }> {
  const threshold = runtime.loaded.config.knowledge.retrieval.rankAbove;
  if (docs.length <= threshold || query.trim().length === 0) return { docs: [...docs] };
  const result = await search(runtime, roots, query, { kinds: ["knowledge"], limit: 50 });
  const order = new Map<string, number>();
  result.evidence.forEach((e, i) => {
    const name = e.ref.replace(/^knowledge:/, "");
    if (!order.has(name)) order.set(name, i);
  });
  const ranked = [...docs].sort(
    (a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
  return { docs: ranked, result };
}
