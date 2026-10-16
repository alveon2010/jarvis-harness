import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeContracts } from "../../src/design/codeContracts.ts";
import {
  loadCatalog,
  neighboursDoc,
  resolvePlaceholders,
  type ServiceContracts,
  serviceContractsOf,
  springConfigOf,
} from "../../src/knowledge/catalog.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0025 §4: services linked by topics and by the balancer's path segment, without a model. */
const HOST = "$" + "{SERVICE_HOST}";
let sb: Sandbox;
let meta: string;
beforeEach(() => {
  sb = sandbox();
  meta = join(sb.root, "jarvis-knowledge");
  sb.write(
    "jarvis-knowledge/.jarvis/project.yaml",
    "version: 1\nservices:\n  orders-api: {}\n  delivery-slots-api: { path: slots }\n  notify-api: {}\n",
  );
});
afterEach(() => sb.cleanup());

function put(c: ServiceContracts) {
  const dir = join(meta, "knowledge", "services", c.service);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "contracts.json"), JSON.stringify(c));
}

const orders = (): ServiceContracts =>
  serviceContractsOf(
    "orders-api",
    {
      endpoints: [
        {
          file: "OrderController.java",
          key: "OrderController.get",
          method: "GET",
          path: "/orders/{id}",
          direction: "in",
        },
        {
          file: "SlotsClient.java",
          key: "SlotsClient.slot",
          method: "GET",
          path: "/delivery-slots/{slotId}",
          direction: "out",
          client: "slots",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a Spring placeholder
          url: "${clients.slots.url}",
          line: 7,
        },
        {
          file: "PartnerClient.java",
          method: "POST",
          path: "/check",
          direction: "out",
          client: "external",
          url: "https://partner.example.com/api",
        },
      ],
      topics: [{ topic: "orders.created", property: "kafka.topics.orders-created", file: "application.yml" }],
      listeners: [],
      senders: [
        {
          type: "OrderEventPublisher",
          file: "OrderEventPublisher.java",
          line: 41,
          topics: [
            { topic: "orders.created", property: "kafka.topics.orders-created", file: "application.yml" },
          ],
        },
      ],
    } satisfies CodeContracts,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the balancer's host stays a placeholder
    { "clients.slots.url": "http://${SERVICE_HOST}/slots" },
  );

describe("the contract catalog", () => {
  it("keeps a service's contracts with the client's address resolved from its configuration", () => {
    const c = orders();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the balancer's host
    expect(c.calls[0]?.url).toBe("http://${SERVICE_HOST}/slots");
    expect(c.produces).toEqual([
      {
        topic: "orders.created",
        property: "kafka.topics.orders-created",
        senders: ["OrderEventPublisher"],
        file: "OrderEventPublisher.java",
        line: 41,
      },
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an unknown placeholder stays
    expect(resolvePlaceholders("${a}/x/${b.c}", { a: "http://h" })).toBe("http://h/x/${b.c}");
  });

  it("links a topic by name and a client by the balancer's segment, the endpoint with or without it", () => {
    put(orders());
    put({
      version: 1,
      service: "delivery-slots-api",
      serves: [{ method: "GET", path: "/delivery-slots/{id}", file: "SlotController.java", line: 12 }],
      calls: [],
      produces: [],
      consumes: [
        { topic: "orders.created", handler: "OrderCreatedListener.on", file: "OrderCreatedListener.java" },
      ],
    });
    put({
      version: 1,
      service: "notify-api",
      serves: [],
      calls: [
        {
          method: "GET",
          path: "/delivery-slots/{id}",
          url: `http://${HOST}/delivery-slots-api`,
          file: "Slots.kt",
        },
        {
          method: "GET",
          path: "/orders/{orderId}/lines",
          url: `http://${HOST}/orders-api`,
          file: "Orders.kt",
        },
      ],
      produces: [],
      consumes: [{ topic: "orders.created", file: "Listener.kt" }],
    });
    const catalog = loadCatalog(meta);
    expect(
      catalog.links.map(
        (l) => `${l.kind} ${l.what}: ${l.producer} → ${l.consumer}${l.endpointFound ? "" : " ?"}`,
      ),
    ).toEqual([
      "topic orders.created: orders-api → delivery-slots-api",
      "topic orders.created: orders-api → notify-api",
      "http GET /delivery-slots/{id}: delivery-slots-api → notify-api",
      "http GET /delivery-slots/{id}: delivery-slots-api → orders-api",
      "http GET /orders/{orderId}/lines: orders-api → notify-api ?",
    ]);
    expect(catalog.unresolved.map((u) => u.call.path)).toEqual(["/check"]);

    const doc = neighboursDoc(catalog, "orders-api") ?? "";
    expect(doc).toContain("- topic `orders.created` — delivery-slots-api, notify-api");
    expect(doc).toContain("- `GET /orders/{orderId}/lines` — notify-api (endpoint not found there)");
    expect(doc).toContain("## Used by orders-api\n\n- `GET /delivery-slots/{id}` — delivery-slots-api");
    expect(doc).toContain("`POST /check` at `https://partner.example.com/api` (client external)");
  });

  it("reads a Spring configuration as dotted keys, the default profile first", () => {
    sb.write("svc/src/main/resources/application.yml", "clients:\n  slots:\n    url: http://gw/slots\n");
    sb.write(
      "svc/src/main/resources/application-dev.yml",
      "clients:\n  slots:\n    url: http://dev/slots\n  other: x\n",
    );
    sb.write("svc/src/main/resources/application.properties", "feature.flag=true\n");
    const config = springConfigOf(join(sb.root, "svc"), [
      "src/main/resources/application-dev.yml",
      "src/main/resources/application.yml",
      "src/main/resources/application.properties",
    ]);
    expect(config["clients.slots.url"]).toBe("http://gw/slots");
    expect(config["clients.other"]).toBe("x");
    expect(config["feature.flag"]).toBe("true");
  });
});
