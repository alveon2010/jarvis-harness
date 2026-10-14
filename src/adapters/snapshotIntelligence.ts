import type { CodeIntelligence, SymbolRef } from "../core/capabilities/contracts.ts";
import type { Snapshot } from "../knowledge/graph/store.ts";

/**
 * Code intelligence answered from the latest graph snapshot (ADR-0021 §6): symbols, file-level
 * references and dependencies — the same for every stack whose extractor fills the graph.
 */
export function snapshotIntelligence(snapshot: () => Snapshot | undefined): CodeIntelligence {
  const toRef = (n: {
    id: string;
    kind: string;
    file?: string;
    metadata?: Record<string, unknown>;
  }): SymbolRef => ({
    name: n.id.includes("#") ? (n.id.split("#")[1] as string) : n.id,
    kind:
      n.kind === "Function"
        ? "function"
        : n.kind === "Type"
          ? "type"
          : n.kind === "Test"
            ? "test"
            : n.kind === "Module"
              ? "module"
              : "variable",
    range: {
      file: n.file ?? n.id,
      startLine: Number(n.metadata?.line ?? 1),
      endLine: Number(n.metadata?.line ?? 1),
    },
    handle: n.id,
  });
  return {
    async findSymbol(query) {
      const s = snapshot();
      if (!s) return [];
      return s.nodes
        .filter((n) => n.id.includes("#"))
        .filter(
          (n) => (!query.name || n.id.endsWith(`#${query.name}`)) && (!query.file || n.file === query.file),
        )
        .map(toRef)
        .filter((r) => !query.kind || r.kind === query.kind);
    },
    async findReferences(symbol) {
      const s = snapshot();
      if (!s) return [];
      // Module-level precision: files that import the symbol's file.
      return s.edges
        .filter((e) => e.relation === "DEPENDS_ON" && e.to === symbol.range.file)
        .map((e) => ({
          symbol,
          range: { file: e.from, startLine: 1, endLine: 1 },
          kind: "import" as const,
        }));
    },
    async getDefinition(symbol) {
      const s = snapshot();
      const node = s?.nodes.find((n) => n.id === symbol.handle);
      return node ? { symbol: toRef(node) } : null;
    },
    async getDependencies(target) {
      const s = snapshot();
      if (!s) return [];
      return s.edges
        .filter((e) => e.from === target.file)
        .map((e) => ({ from: e.from, to: e.to, relation: e.relation }));
    },
    async getDiagnostics() {
      return [];
    },
  };
}
