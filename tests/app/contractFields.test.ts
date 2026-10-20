import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Checkout, dtoChecksOf } from "../../src/app/contractFields.ts";
import type { ServiceContracts } from "../../src/knowledge/catalog.ts";

/** ADR-0025 §6: the declared types of a topic's sender and listener, an endpoint's body and response. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(files: Record<string, string>, changed: string[] = []): Checkout {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dto-"));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return new Checkout(root, Object.keys(files).sort(), new Set(changed));
}

const facts = (service: string, parts: Partial<ServiceContracts>): ServiceContracts => ({
  version: 1,
  service,
  serves: [],
  calls: [],
  produces: [],
  consumes: [],
  ...parts,
});

const EVENT = (fields: string) =>
  `package com.example;\n\n@Value\npublic class OrderCreatedEvent {\n${fields}\n}\n`;

describe("the DTOs between a producer and a consumer", () => {
  it("a topic: the type its sender's KafkaTemplate sends against the type its listener reads", () => {
    const producer = {
      service: "orders-api",
      facts: facts("orders-api", {
        produces: [
          { topic: "orders.created", senders: ["OrderEvents"], file: "src/OrderEvents.java", line: 3 },
        ],
      }),
      checkout: checkout({
        "src/OrderEvents.java":
          "class OrderEvents {\n  private final KafkaTemplate<String, OrderCreatedEvent> kafka;\n}\n",
        "src/OrderCreatedEvent.java": EVENT("  String orderId;\n  Long deliverySlotId;"),
      }),
    };
    const consumer = {
      service: "notify-api",
      facts: facts("notify-api", {
        consumes: [
          {
            topic: "orders.created",
            handler: "OrderListener.onCreated",
            file: "src/OrderListener.java",
            line: 2,
          },
        ],
      }),
      checkout: checkout({
        "src/OrderListener.java":
          'class OrderListener {\n  @KafkaListener(topics = "orders.created")\n  void onCreated(OrderCreatedEvent event) {}\n}\n',
        "src/OrderCreatedEvent.java": EVENT("  String orderId;"),
      }),
    };
    const item = {
      kind: "topic" as const,
      id: "orders.created",
      change: "+ deliverySlotId",
      producer: "orders-api",
      consumers: ["notify-api"],
    };
    const [check] = dtoChecksOf(item, producer, consumer);
    expect(check).toMatchObject({
      role: "payload",
      dto: "OrderCreatedEvent",
      writer: "orders-api",
      reader: "notify-api",
      writerAt: "src/OrderCreatedEvent.java:4",
    });
    // the consumer does not read the new field yet: added on the writer's side, which holds
    expect(check?.fields?.map((f) => [f.field, f.change, f.status])).toEqual([
      ["deliverySlotId", "added", "ok"],
      ["orderId", "same", "ok"],
    ]);
    // a sender of Object: its type is not seen — said, not failed
    const blind = {
      ...producer,
      checkout: checkout({
        "src/OrderEvents.java":
          "class OrderEvents {\n  private final KafkaTemplate<String, Object> kafka;\n}\n",
      }),
    };
    expect(dtoChecksOf(item, blind, consumer)).toEqual([
      {
        role: "payload",
        dto: "OrderCreatedEvent",
        writer: "orders-api",
        reader: "notify-api",
        note: "the type is not declared in orders-api: fields not checked",
      },
    ]);
  });

  it("an endpoint: the request body goes from the client to the server, the response back", () => {
    const producer = {
      service: "delivery-slots-api",
      facts: facts("delivery-slots-api", {
        serves: [
          {
            method: "POST",
            path: "/slots/{id}",
            handler: "SlotController.reserve",
            file: "src/SlotController.java",
          },
        ],
      }),
      checkout: checkout({
        "src/SlotController.java":
          'class SlotController {\n  @PostMapping("/slots/{id}")\n  public ResponseEntity<SlotDto> reserve(@PathVariable String id, @RequestBody ReserveSlot body) {\n    return null;\n  }\n}\n',
        "src/SlotDto.java": "record SlotDto(String id, int capacity) {}\n",
        "src/ReserveSlot.java": "class ReserveSlot {\n  private String orderId;\n}\n",
      }),
    };
    const consumer = {
      service: "orders-api",
      facts: facts("orders-api", {
        calls: [
          {
            method: "POST",
            path: "/slots/{id}",
            handler: "SlotsClient.reserve",
            file: "src/SlotsClient.java",
            url: "http://slots.internal/delivery-slots-api",
          },
        ],
      }),
      checkout: checkout(
        {
          "src/SlotsClient.java":
            'interface SlotsClient {\n  @PostMapping("/slots/{id}")\n  SlotDto reserve(@PathVariable("id") String id, @RequestBody ReserveSlot body);\n}\n',
          "src/SlotDto.java": "record SlotDto(String id, long capacity, String window) {}\n",
          "src/ReserveSlot.java":
            "class ReserveSlot {\n  private String orderId;\n  private String note;\n}\n",
        },
        ["src/SlotDto.java"],
      ),
    };
    const checks = dtoChecksOf(
      {
        kind: "endpoint",
        id: "POST /slots/{id}",
        change: "",
        producer: "delivery-slots-api",
        consumers: ["orders-api"],
      },
      producer,
      consumer,
    );
    expect(
      checks.map((c) => [c.role, c.writer, c.reader, c.fields?.map((f) => `${f.field} ${f.change}`)]),
    ).toEqual([
      ["request", "orders-api", "delivery-slots-api", ["note added", "orderId same"]],
      ["response", "delivery-slots-api", "orders-api", ["capacity same", "id same", "window removed"]],
    ]);
  });
});
