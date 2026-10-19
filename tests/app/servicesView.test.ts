import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { descriptionOf, servicesOf, servicesToFinish, stacksLineOf } from "../../src/app/servicesView.ts";
import type { Run } from "../../src/core/domain/run.ts";

/** The Services page's data: the map, each service's documents and contracts, its runs. */
let dir: string;
const meta = () => join(dir, "shop-knowledge");
const write = (rel: string, text: string) => {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const contracts = (service: string, extra: Record<string, unknown>) =>
  JSON.stringify({ version: 1, service, serves: [], calls: [], produces: [], consumes: [], ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svc-"));
  write(
    "shop-knowledge/project.yaml",
    [
      "version: 1",
      "tools:",
      "  local:",
      "    lint: make lint",
      "services:",
      "  orders-api:",
      "    kind: backend",
      "    tools:",
      "      local:",
      "        tests: ./gradlew test",
      "        typecheck: ./gradlew compileJava",
      "  notifications-worker: {}",
      "  address-service: {}",
      "",
    ].join("\n"),
  );
  for (const s of ["orders-api", "notifications-worker", "web-portal"])
    mkdirSync(join(dir, s, ".git"), { recursive: true });
  write("notifications-worker/package.json", "{}");
  write(
    "shop-knowledge/knowledge/services/orders-api/architecture.md",
    [
      "---",
      "tags: [architecture]",
      "---",
      "# orders-api",
      "",
      "Takes and tracks orders: the cart becomes an order at **checkout**.",
      "It refunds through payments.",
      "",
      "Layers: api → application → domain.",
      "",
      "## Stack",
      "",
      "- Stacks: java, spring; package manager gradle",
      "",
    ].join("\n"),
  );
  write(
    "shop-knowledge/knowledge/services/orders-api/modules/checkout.md",
    "---\ntags: [module]\n---\n# checkout\n",
  );
  write(
    "shop-knowledge/knowledge/services/orders-api/contracts.json",
    contracts("orders-api", {
      produces: [{ topic: "order.created", senders: ["OrderEvents"], file: "a.java" }],
    }),
  );
  write(
    "shop-knowledge/knowledge/services/notifications-worker/contracts.json",
    contracts("notifications-worker", { consumes: [{ topic: "order.created", file: "b.js" }] }),
  );
  write(
    "shop-knowledge/knowledge/services/notifications-worker/architecture.md",
    "---\ntags: [architecture, generated]\n---\n<!-- jarvis:onboard -->\n# Architecture\n\n## Stack\n\n- Stacks: node\n",
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const repos = () => ({
  "orders-api": join(dir, "orders-api"),
  "notifications-worker": join(dir, "notifications-worker"),
  "address-service": join(dir, "address-service"),
});
const run = (id: string, repoRoot: string, updatedAt: string): Run =>
  ({
    id,
    task: `task ${id}`,
    workflow: "sdd",
    state: "COMPLETED",
    workspace: { repoRoot },
    updatedAt,
    createdAt: updatedAt,
  }) as unknown as Run;

describe("services of a knowledge repository", () => {
  it("each service: kind, stack, commands over the shared ones, what is missing", () => {
    const view = servicesOf({ metaRoot: meta(), repos: repos(), runs: [] });
    expect(view.services.map((s) => s.name)).toEqual([
      "address-service",
      "notifications-worker",
      "orders-api",
    ]);
    const orders = view.services.find((s) => s.name === "orders-api");
    expect(orders).toMatchObject({
      kind: "backend",
      stack: "gradle · java, spring",
      present: true,
      missing: [],
    });
    expect(orders?.tools).toEqual([
      { name: "tests", command: "./gradlew test", from: "service" },
      { name: "typecheck", command: "./gradlew compileJava", from: "service" },
      { name: "lint", command: "make lint", from: "shared" },
    ]);
    const worker = view.services.find((s) => s.name === "notifications-worker");
    expect(worker).toMatchObject({
      stack: "node",
      required: ["tests"],
      missing: ["tests"],
      optional: ["typecheck"],
      hasArchitecture: true,
    });
    expect(worker?.about).toBeUndefined();
    expect(view.services.find((s) => s.name === "address-service")).toMatchObject({
      present: false,
      hasArchitecture: false,
    });
  });

  it("the description: paragraphs under the title, before the first section", () => {
    const orders = servicesOf({ metaRoot: meta(), repos: repos(), runs: [] }).services.find(
      (s) => s.name === "orders-api",
    );
    expect(orders?.about).toBe(
      "Takes and tracks orders: the cart becomes an order at checkout. It refunds through payments.",
    );
    expect(orders?.more).toEqual(["Layers: api → application → domain."]);
    expect(orders).toMatchObject({ docs: 2, modules: 1 });
    expect(descriptionOf("# x\n\n- a list\n\n| t |\n\n## A\n\ntext")).toEqual([]);
    expect(stacksLineOf("- Stacks: none found")).toBeUndefined();
  });

  it("links from the catalog, repositories not in the map, runs in each service", () => {
    const view = servicesOf({
      metaRoot: meta(),
      repos: repos(),
      projectRoot: join(dir, "orders-api"),
      runs: [
        run("run_a", join(dir, "orders-api"), "2026-10-01T00:00:00.000Z"),
        run("run_b", join(dir, "orders-api"), "2026-10-02T00:00:00.000Z"),
        run("run_c", join(dir, "web-portal"), "2026-10-02T00:00:00.000Z"),
      ],
    });
    expect(view.current).toBe("orders-api");
    expect(view.links).toMatchObject([
      { kind: "topic", what: "order.created", producer: "orders-api", consumer: "notifications-worker" },
    ]);
    const orders = view.services.find((s) => s.name === "orders-api");
    expect(orders?.runs.map((r) => r.id)).toEqual(["run_b", "run_a"]);
    expect(orders?.links).toHaveLength(1);
    expect(view.unmapped.map((r) => r.name)).toEqual(["web-portal"]);
    expect(servicesToFinish(view)).toEqual({
      noTools: ["notifications-worker"],
      noAbout: ["address-service", "notifications-worker"],
      absent: ["address-service"],
    });
  });
});
