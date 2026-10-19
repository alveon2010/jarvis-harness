import type { Run } from "../core/domain/run.ts";
import { catalogDoc, catalogOf, namedServices } from "../knowledge/catalog.ts";
import type { Runtime } from "./runtime.ts";
import { libraryMapOf } from "./subtasks.ts";

/**
 * The catalog of a task across services (ADR-0025 §6) — the services of the map, their links, the
 * libraries and what the task and its spec name — as the research and the split read it. No model.
 * Undefined outside a knowledge repository.
 */
export function crossCatalogText(runtime: Runtime, run: Run): string | undefined {
  const meta = runtime.loaded.meta;
  if (!meta) return undefined;
  const catalog = catalogOf(meta.root);
  const names = Object.keys(meta.repos).sort();
  const spec = runtime.artifacts.listLatest(run.id, "spec")[0];
  const text = `${run.task}\n${spec ? runtime.artifacts.text(spec) : ""}`;
  const named = namedServices(catalog, text, names);
  const map = libraryMapOf(runtime);
  const libraries = [...map.libraries].sort().map((service) => ({
    service,
    publishes: map.publishes.get(service) ?? [],
    usedBy: names.filter((n) => (map.uses.get(n) ?? []).includes(service)),
  }));
  return catalogDoc(catalog, names, named, libraries);
}
