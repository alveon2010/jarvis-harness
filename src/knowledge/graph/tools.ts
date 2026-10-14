import type { Capability, ToolProvider } from "../../tools/types.ts";
import type { GraphStore } from "./store.ts";
import { impactOf, neighborsOf, repoIdOf, symbolOf } from "./update.ts";

/**
 * Graph capabilities for agents (ADR-0008, ADR-0021 §4): answered from the latest snapshot of the
 * workspace's repository; without one they say so instead of guessing.
 */
export class GraphToolProvider implements ToolProvider {
  readonly name = "graph";
  private readonly store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  capabilities(): readonly Capability[] {
    const snapshot = (workspace: string) => {
      const latest = this.store.latest(repoIdOf(workspace));
      return latest ? this.store.load(latest.id) : undefined;
    };
    const missing = {
      ok: false,
      error: "no project graph snapshot for this workspace; run `jarvis knowledge update`",
    };
    return [
      {
        name: "graph.impact",
        description:
          "Who depends on these files (transitively) and which tests cover them, from the project graph.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { files: { type: "array", items: { type: "string" } }, depth: { type: "integer" } },
          required: ["files"],
        },
        handler: async (args, ctx) => {
          const s = snapshot(ctx.workspacePath);
          if (!s) return missing;
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          const result = impactOf(s, files, typeof args.depth === "number" ? args.depth : 3);
          const text = [
            `snapshot ${s.id} (${s.treeSha.slice(0, 10)}, ${s.nodes.length} nodes, ${s.edges.length} edges)`,
            `dependents (${result.dependents.length}):`,
            ...result.dependents.map((d) => `  ${d.file} (distance ${d.distance})`),
            `tests (${result.tests.length}):`,
            ...result.tests.map((t) => `  ${t}`),
            ...(result.unresolved.length > 0 ? [`unresolved imports: ${result.unresolved.join(", ")}`] : []),
          ].join("\n");
          return { ok: true, text, data: result };
        },
      },
      {
        name: "graph.neighbors",
        description: "Imports, importers, tests and symbols of one file, from the project graph.",
        network: "none",
        access: "read",
        effect: false,
        parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
        handler: async (args, ctx) => {
          const s = snapshot(ctx.workspacePath);
          if (!s) return missing;
          const n = neighborsOf(s, String(args.file ?? ""));
          const text = [
            `imports: ${n.imports.join(", ") || "-"}`,
            `imported by: ${n.importedBy.join(", ") || "-"}`,
            `tests: ${n.tests.join(", ") || "-"}`,
            `symbols: ${n.symbols.join(", ") || "-"}`,
          ].join("\n");
          return { ok: true, text, data: n };
        },
      },
      {
        name: "graph.symbol",
        description:
          "A class or a method by name (`OrderService`, `OrderService.find`): where it is defined, its supertypes and implementations, who calls it (also through its interface) and what it calls — from the project graph, one call instead of a search.",
        network: "none",
        access: "read",
        effect: false,
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        handler: async (args, ctx) => {
          const s = snapshot(ctx.workspacePath);
          if (!s) return missing;
          const found = symbolOf(s, String(args.name ?? ""));
          if (found.length === 0)
            return {
              ok: false,
              error: `no class or method "${String(args.name ?? "")}" in the project graph`,
            };
          const at = (r: { id: string; file: string; line?: number }) =>
            `${r.id.slice(r.id.indexOf("#") + 1)} (${r.file}${r.line ? `:${r.line}` : ""})`;
          const MAX = 40;
          const section = (
            title: string,
            items: ReadonlyArray<{ id: string; file: string; line?: number; via?: string }>,
          ) =>
            items.length === 0
              ? []
              : [
                  `${title} (${items.length}):`,
                  ...items.slice(0, MAX).map((r) => `  ${at(r)}${r.via ? ` — via ${r.via}` : ""}`),
                  ...(items.length > MAX ? [`  … ${items.length - MAX} more`] : []),
                ];
          const text = found
            .flatMap((f) => [
              `${at(f)}${f.endLine ? `–${f.endLine}` : ""}`,
              ...section("supertypes", f.supertypes),
              ...section("implementations / subtypes", f.subtypes),
              ...section("called by", f.callers),
              ...section("calls", f.callees),
              "",
            ])
            .join("\n")
            .trim();
          return { ok: true, text, data: found };
        },
      },
    ];
  }
}
