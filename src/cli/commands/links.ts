import { type CatalogLink, loadCatalog } from "../../knowledge/catalog.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis knowledge links [--service <name>]` — the links the contract catalog of a knowledge
 * repository finds between services (ADR-0025 §4), as a checklist for a person who knows them: right,
 * wrong, missing. The gate that stops a plain sdd trusts only the kinds of links this review confirms.
 */
export async function runKnowledgeLinks(ctx: CliContext, options: { service?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const meta = loaded.meta;
  if (!meta)
    throw new CliExit(
      EXIT.error,
      "not a knowledge repository or one of its services: the catalog links services (ADR-0025)",
    );
  const catalog = loadCatalog(meta.root);
  const of = (l: CatalogLink) =>
    !options.service || l.producer === options.service || l.consumer === options.service;
  const links = catalog.links.filter(of);
  const unresolved = catalog.unresolved.filter((u) => !options.service || u.service === options.service);
  const withoutFacts = Object.keys(meta.repos).filter((s) => !catalog.services.has(s));
  ctx.out.result({ links, unresolved, withoutContracts: withoutFacts }, () => {
    ctx.out.line(
      `${catalog.services.size} services with contracts.json${withoutFacts.length > 0 ? `; without (run jarvis onboard there): ${withoutFacts.join(", ")}` : ""}`,
    );
    ctx.out.line();
    ctx.out.line("Check each: [x] right, [-] wrong; add what is missing at the end.");
    ctx.out.line();
    for (const kind of ["topic", "http"] as const) {
      const ofKind = links.filter((l) => l.kind === kind);
      if (ofKind.length === 0) continue;
      ctx.out.line(kind === "topic" ? "## Topics (sends → reads)" : "## HTTP (serves ← calls)");
      for (const l of ofKind)
        ctx.out.line(
          `- [ ] ${l.what}: ${l.producer} → ${l.consumer}${l.kind === "http" && !l.endpointFound ? " (endpoint not found in the producer)" : ""}  ${[l.producerAt, l.consumerAt].filter(Boolean).join(" → ")}`,
        );
      ctx.out.line();
    }
    if (unresolved.length > 0) {
      ctx.out.line("## Calls to an address that names no service");
      for (const u of unresolved)
        ctx.out.line(
          `- ${u.service}: ${u.call.method ? `${u.call.method} ` : ""}${u.call.path}${u.call.url ? ` at ${u.call.url}` : ""}${u.call.client ? ` (client ${u.call.client})` : ""}  ${u.call.file}${u.call.line ? `:${u.call.line}` : ""}`,
        );
      ctx.out.line();
    }
    ctx.out.line("## Missing (write here what the catalog did not find)");
  });
}
