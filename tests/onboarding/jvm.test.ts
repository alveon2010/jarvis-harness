import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/core/capabilities/contracts.ts";
import { codeContractsOf } from "../../src/design/codeContracts.ts";
import { renderContracts } from "../../src/onboarding/render.ts";
import { jvmFactsOf, moduleLayoutOf, moduleOf, rolOf } from "../../src/onboarding/scan.ts";

const B = "src/main/java/com/example/orders";
const T = "src/test/groovy/com/example/orders";
const FILES = [
  `${B}/Application.java`,
  `${B}/service/OrderService.java`,
  `${B}/service/slots/SlotService.java`,
  `${B}/web/OrderController.java`,
  `${T}/web/OrderControllerSpecification.groovy`,
  `${T}/BaseSpecification.groovy`,
  "src/main/resources/application.yml",
  "build.gradle",
];

describe("modules of a JVM tree", () => {
  it("are the packages right below each source root's base package", () => {
    const layout = moduleLayoutOf(FILES);
    expect(layout.jvm).toEqual([
      { root: "src/test/groovy", base: T },
      { root: "src/main/java", base: B },
    ]);
    expect(moduleOf(`${B}/service/slots/SlotService.java`, layout)).toBe(`${B}/service`);
    expect(moduleOf(`${B}/Application.java`, layout)).toBe(B);
    expect(moduleOf("src/main/resources/application.yml", layout)).toBe("src/main/resources");
    expect(moduleOf("build.gradle", layout)).toBe("(root)");
    // without a layout: as before
    expect(moduleOf(`${B}/service/OrderService.java`)).toBe("src/main");
    expect(rolOf(`${T}/web`, "src")).toBe("tests");
    expect(rolOf("src/main/resources", "src")).toBe("config");
    expect(rolOf(`${B}/web`, "src")).toBe("source");
  });

  it("know their tests' naming, frameworks and shared test code, and the main code's libraries", () => {
    const layout = moduleLayoutOf(FILES);
    const nodes: GraphNode[] = [
      {
        id: `${T}/web/OrderControllerSpecification.groovy`,
        kind: "Test",
        file: `${T}/web/OrderControllerSpecification.groovy`,
      },
    ];
    const edges: GraphEdge[] = [
      { from: "pkg:spock.lang", to: `${T}/web/OrderControllerSpecification.groovy`, relation: "TESTED_BY" },
      {
        from: "pkg:org.springframework.test.web.servlet",
        to: `${T}/web/OrderControllerSpecification.groovy`,
        relation: "TESTED_BY",
      },
      {
        from: `${T}/BaseSpecification.groovy`,
        to: `${T}/web/OrderControllerSpecification.groovy`,
        relation: "TESTED_BY",
      },
      {
        from: `${T}/BaseSpecification.groovy`,
        to: "pkg:org.testcontainers.containers",
        relation: "DEPENDS_ON",
      },
      {
        from: `${B}/web/OrderController.java`,
        to: "pkg:org.springframework.web.bind.annotation",
        relation: "DEPENDS_ON",
      },
      { from: `${B}/service/OrderService.java`, to: "pkg:lombok", relation: "DEPENDS_ON" },
    ];
    expect(jvmFactsOf(layout, edges, nodes)).toEqual({
      testRoots: [
        {
          root: "src/test/groovy",
          tests: 1,
          suffixes: ["*Specification (1)"],
          frameworks: ["MockMvc (1)", "Spock (1)", "Testcontainers (1)"],
        },
      ],
      shared: [{ file: `${T}/BaseSpecification.groovy`, tests: 1 }],
      libraries: ["Lombok", "Spring MVC"],
    });
  });
});

describe("contracts.md", () => {
  it("lists what the code serves, calls and reads, scoped to the files that declare it", () => {
    const nodes: GraphNode[] = [
      {
        id: `${B}/web/OrderController.java#GET /api/orders/{id}`,
        kind: "Endpoint",
        file: `${B}/web/OrderController.java`,
        metadata: {
          method: "GET",
          path: "/api/orders/{id}",
          handler: "OrderController.get",
          direction: "in",
          line: 12,
        },
      },
      {
        id: `${B}/client/SlotsClient.java#GET /slots`,
        kind: "Endpoint",
        file: `${B}/client/SlotsClient.java`,
        metadata: {
          method: "GET",
          path: "/slots",
          handler: "SlotsClient.slots",
          direction: "out",
          client: "slots",
        },
      },
      // an API interface its controller implements: served
      {
        id: `${B}/web/OrdersApi.java#POST /api/orders`,
        kind: "Endpoint",
        file: `${B}/web/OrdersApi.java`,
        metadata: { method: "POST", path: "/api/orders", handler: "OrdersApi.create", direction: "out" },
      },
      {
        id: `${B}/web/OrderController.java#OrderController`,
        kind: "Type",
        file: `${B}/web/OrderController.java`,
        metadata: { annotations: ["RestController"], implements: ["OrdersApi"] },
      },
      {
        id: "src/main/resources/application.yml#topic orders.topics.paid",
        kind: "Event",
        file: "src/main/resources/application.yml",
        metadata: { role: "topic", property: "orders.topics.paid", topic: "orders.paid", line: 3 },
      },
      {
        id: `${B}/kafka/PaidListener.java#listens \${orders.topics.paid}`,
        kind: "Event",
        file: `${B}/kafka/PaidListener.java`,
        metadata: { role: "listens", property: "orders.topics.paid", handler: "PaidListener.on" },
      },
    ];
    const doc = renderContracts(codeContractsOf(nodes)) ?? "";
    expect(doc).toContain(
      `paths: ["${B}/client/**", "${B}/kafka/**", "${B}/web/**", "src/main/resources/**"]`,
    );
    expect(doc).toContain("## HTTP endpoints served (2)");
    expect(doc).toContain("- `GET /api/orders/{id}` — `OrderController.get` :12");
    expect(doc).toContain("- `POST /api/orders` — `OrdersApi.create`");
    expect(doc).toContain("## Calls to other services (1)\n\n### `slots` through SlotsClient");
    expect(doc).toContain("| `orders.topics.paid` | `orders.paid` | application.yml:3 | `PaidListener.on` |");
    expect(renderContracts({ endpoints: [], topics: [], listeners: [] })).toBeUndefined();
  });
});
