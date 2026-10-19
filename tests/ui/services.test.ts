import { describe, expect, it } from "vitest";
import type { ServicesView, ServiceView } from "../../src/app/servicesView.ts";
import type { CatalogLink } from "../../src/knowledge/catalog.ts";
import {
  graphSvg,
  pairsOf,
  type ServicesPage,
  serviceContent,
  servicesContent,
} from "../../src/ui/services.ts";

/** Knowledge → Services as a person reads it: the map, what is left, the links; a page per service. */
const links: CatalogLink[] = [
  {
    kind: "http",
    what: "POST /payments",
    producer: "payments-service",
    consumer: "orders-api",
    endpointFound: true,
    consumerAt: "src/Pay.java:12",
  },
  {
    kind: "http",
    what: "POST /refunds",
    producer: "payments-service",
    consumer: "orders-api",
    endpointFound: true,
  },
  {
    kind: "topic",
    what: "order.created",
    producer: "orders-api",
    consumer: "notifications-worker",
    endpointFound: true,
  },
];

const service = (name: string, extra: Partial<ServiceView>): ServiceView => ({
  name,
  repo: `/home/me/code/${name}`,
  present: true,
  tools: [],
  required: ["tests"],
  missing: ["tests"],
  optional: ["typecheck", "lint"],
  publishes: [],
  uses: [],
  usedBy: [],
  architecture: `knowledge/services/${name}/architecture.md`,
  hasArchitecture: false,
  more: [],
  docs: 0,
  modules: 0,
  links: links.filter((l) => l.producer === name || l.consumer === name),
  runs: [],
  ...extra,
});

const orders = service("orders-api", {
  kind: "backend",
  stack: "gradle · java",
  tools: [
    { name: "tests", command: "./gradlew test", from: "service" },
    { name: "typecheck", command: "./gradlew compileJava", from: "service" },
    { name: "lint", command: "make lint", from: "shared" },
  ],
  missing: [],
  hasArchitecture: true,
  about: "Takes and tracks orders.",
  more: ["Layers: api → domain."],
  docs: 3,
  modules: 2,
  contracts: {
    version: 1,
    service: "orders-api",
    serves: [{ method: "POST", path: "/orders", file: "src/Orders.java" }],
    calls: [{ method: "POST", path: "/payments", file: "src/Pay.java", line: 12, client: "payClient" }],
    produces: [{ topic: "order.created", senders: ["OrderEvents"], file: "src/Ev.java" }],
    consumes: [],
  },
  runs: [
    {
      id: "run_e681da4d00000000",
      task: "ABC-42 allow a second order",
      workflow: "sdd",
      state: "COMPLETED",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
});
const view: ServicesView = {
  metaRoot: "/home/me/code/shop-knowledge",
  configFile: "/home/me/code/shop-knowledge/project.yaml",
  current: "orders-api",
  services: [
    service("address-service", { present: false }),
    service("notifications-worker", { hasArchitecture: true, docs: 1 }),
    orders,
    service("payments-service", { kind: "backend", missing: [], about: "Charges and refunds." }),
  ],
  links,
  unmapped: [{ name: "web-portal", path: "/home/me/code/web-portal", ownJarvis: false, mapped: false }],
};
const page: ServicesPage = {
  counts: { docs: 4, standards: 0, skills: 0, terms: 0, services: 4 },
  view,
  homeDir: "/home/me",
  configPath: "project.yaml",
  fileOf: (rel) => rel,
  canOnboard: true,
};
const actions = { token: "tok" } as never;

describe("Services", () => {
  it("links grouped by pair, the caller first", () => {
    expect(pairsOf(links)).toEqual([
      { from: "orders-api", to: "payments-service", kind: "http", what: ["POST /payments", "POST /refunds"] },
      { from: "orders-api", to: "notifications-worker", kind: "topic", what: ["order.created"] },
    ]);
  });

  it("the graph: callers above what they call; nothing to draw without links", () => {
    const svg = String(
      graphSvg(
        ["a", "b", "c"],
        pairsOf(links.map((l) => ({ ...l, producer: "b", consumer: "a" }))),
        new Map(),
      ),
    );
    expect(svg).toContain('aria-label="a calls b; b sends to a"');
    expect(svg).toContain('href="/knowledge/services?name=a"');
    expect(String(graphSvg(["a"], [], new Map()))).toBe("");
  });

  it("the map: what is left to finish, each service's row, the repositories not in the map", () => {
    const out = String(servicesContent(page, actions));
    expect(out).toContain(">Services <span");
    expect(out).toContain("<b>4 things to finish</b>");
    expect(out).toContain(
      "1 service without a required check, 2 services without a description, 1 not on this machine",
    );
    // only the services on this machine are onboarded
    expect(out).toContain(
      '<input type="hidden" name="service" value="notifications-worker"><input type="hidden" name="back" value="/knowledge/services">',
    );
    expect(out).not.toContain('name="service" value="address-service"');
    expect(out).toContain("Onboard 1 service");
    expect(out).toContain("Takes and tracks orders.");
    expect(out).toContain('title="make lint (shared)">✓ lint');
    // what is not in tools.required is optional, not left to do
    expect(out).toContain("optional: typecheck, lint</div>");
    expect(out).toContain('→ payments-service <span class="muted">2 endpoints</span>');
    expect(out).toContain("⇢ <code>order.created</code>");
    expect(out).toContain("expected at <code>~/code/address-service</code>");
    expect(out).toContain("not in the map: <code>web-portal</code> — add under services: if it is one");
    expect(out).toContain('class="kr sv current"');
    expect(out).toContain('<svg class="sg"');
  });

  it("a service: its description, commands, contracts with the other end, its tasks", () => {
    const out = String(serviceContent(page, orders, actions));
    expect(out).toContain('<h2 class="sv-h1">orders-api</h2>');
    expect(out).toContain('<p class="sv-lead">Takes and tracks orders.</p><p>Layers: api → domain.</p>');
    expect(out).toContain('name="file" value="knowledge/services/orders-api/architecture.md"');
    expect(out).toContain("Onboard again");
    expect(out).toContain('href="/?repo=%2Fhome%2Fme%2Fcode%2Forders-api"');
    expect(out).toContain('<dt>lint</dt><dd><code>make lint</code> <span class="muted">shared</span>');
    expect(out).toContain(
      '<code class="sv-path">/payments</code> <span class="muted">· payments-service</span>',
    );
    expect(out).toContain(
      '<span class="sv-verb">SEND</span><span><code class="sv-path">order.created</code> <span class="muted">· notifications-worker</span>',
    );
    expect(out).toContain('href="/runs/e681da4d">ABC-42 allow a second order</a>');
    const bare = String(serviceContent(page, view.services[1] as ServiceView, actions));
    expect(bare).toContain("No description yet: the architecture has only the facts");
    expect(bare).toContain("No commands: the agents change notifications-worker without running its tests.");
  });
});
