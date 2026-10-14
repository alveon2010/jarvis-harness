import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/core/capabilities/contracts.ts";
import { codeContractsOf, topicsNamedIn } from "../../src/design/codeContracts.ts";
import { checkContracts, contractsSection } from "../../src/design/contracts.ts";

const W = "src/main/java/com/example/orders/web";
const NODES: GraphNode[] = [
  {
    id: `${W}/OrderController.java#GET /api/orders/{id}`,
    kind: "Endpoint",
    file: `${W}/OrderController.java`,
    metadata: {
      method: "GET",
      path: "/api/orders/{id}",
      handler: "OrderController.get",
      direction: "in",
      line: 5,
    },
  },
  {
    id: `${W}/SlotsClient.java#GET /slots/{zone}`,
    kind: "Endpoint",
    file: `${W}/SlotsClient.java`,
    metadata: {
      method: "GET",
      path: "/slots/{zone}",
      handler: "SlotsClient.slots",
      direction: "out",
      client: "slots",
      line: 4,
    },
  },
  {
    id: `${W}/BaseAdminController.java#DELETE /{id}`,
    kind: "Endpoint",
    file: `${W}/BaseAdminController.java`,
    metadata: {
      method: "DELETE",
      path: "/{id}",
      handler: "BaseAdminController.remove",
      direction: "in",
      inherited: true,
      line: 3,
    },
  },
  {
    id: `${W}/OrderAdminController.java`,
    kind: "Module",
    file: `${W}/OrderAdminController.java`,
    metadata: { route: "/admin/orders", extends: "BaseAdminController" },
  },
  {
    id: "src/main/resources/application.yml#topic orders.topics.paid.name",
    kind: "Event",
    file: "src/main/resources/application.yml",
    metadata: { role: "topic", property: "orders.topics.paid.name", topic: "orders.paid", line: 4 },
  },
  {
    id: `${W}/OrderController.java#listens \${orders.topics.paid.name}`,
    kind: "Event",
    file: `${W}/OrderController.java`,
    metadata: {
      role: "listens",
      property: "orders.topics.paid.name",
      handler: "OrderController.onPaid",
      line: 12,
    },
  },
];

describe("contracts of the code", () => {
  it("serves a base controller's endpoints under its subclass's route", () => {
    const c = codeContractsOf(NODES);
    expect(c.endpoints.map((e) => [e.method, e.path, e.key, e.direction])).toEqual([
      ["GET", "/api/orders/{id}", "OrderController.get", "in"],
      ["GET", "/slots/{zone}", "SlotsClient.slots", "out"],
      ["DELETE", "/admin/orders/{id}", "OrderAdminController.remove", "in"],
    ]);
  });

  it("finds a topic the sources name by its name or its property, once", () => {
    const c = codeContractsOf(NODES);
    const hits = topicsNamedIn(
      [{ from: "issue ABC-42", text: "Send to orders.paid (orders.topics.paid.name)." }],
      c,
    );
    expect(hits.map((h) => [h.name, h.topics.length, h.listeners.map((l) => l.handler)])).toEqual([
      ["orders.paid", 1, ["OrderController.onPaid"]],
    ]);
    expect(topicsNamedIn([{ from: "t", text: "orders.paid.test and xorders.paid" }], c)).toEqual([]);
  });

  it("checks methods against the code without a map and writes what it found", () => {
    const check = checkContracts(
      "/nonexistent",
      [],
      [
        {
          from: "the task",
          text: "GET /api/orders/{orderId}, DELETE /admin/orders/7, POST /api/refunds; topic orders.paid",
        },
      ],
      codeContractsOf(NODES),
    );
    const text = contractsSection(check as never);
    expect(text).toContain("against the HTTP endpoints of this repository's code (3,");
    expect(text).toContain(
      "- `GET /api/orders/{orderId}` (the task) — in the code: `OrderController.get` · GET · path `/api/orders/{id}` · served here (OrderController.java:5)",
    );
    expect(text).toContain(
      "- `DELETE /admin/orders/7` (the task) — in the code: `OrderAdminController.remove`",
    );
    expect(text).toContain("- `POST /api/refunds` (the task) — **not in the code**");
    expect(text).toContain(
      "- `orders.paid` (the task) — `orders.paid` — property `orders.topics.paid.name` (application.yml:4); listened to by `OrderController.onPaid` (OrderController.java:12)",
    );
    expect(
      checkContracts("/nonexistent", [], [{ from: "t", text: "nothing" }], codeContractsOf(NODES)),
    ).toBeUndefined();
  });
});
