import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JavaAdapter } from "../../src/adapters/java/adapter.ts";
import { JavaExtractor } from "../../src/adapters/java/extractor.ts";
import { JavaResolver } from "../../src/adapters/java/resolver.ts";
import { blankLiterals, parseJvmSource } from "../../src/adapters/java/source.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { impactOf, repoIdOf, updateGraph } from "../../src/knowledge/graph/update.ts";
import { testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

const MAIN = "src/main/java/com/example/orders";
const TEST = "src/test/groovy/com/example/orders";

describe("JVM source", () => {
  it("blanks comments and literals, keeping lines", () => {
    const src = 'a // Order\n/* Slot\n */ b "Cart" \'x\' """Text\n""" c';
    const out = blankLiterals(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toMatch(/Order|Slot|Cart|Text/);
    expect(out).toMatch(/^a [\s\S]* b [\s\S]* c$/);
  });

  it("reads the package, imports, declared and used types", () => {
    const s = parseJvmSource(
      [
        "package com.example.orders;",
        "import com.example.slots.Slot;",
        "import static com.example.util.Money.format;",
        "import com.example.common.*;",
        "",
        "public abstract class OrderService extends BaseService {",
        "  private static final int MAX_ITEMS = 3; // Ignored",
        '  Slot slot; Delivery delivery = new Delivery("Nope");',
        "  private enum State { NEW }",
        "}",
      ].join("\n"),
    );
    expect(s.pkg).toBe("com.example.orders");
    expect(s.imports).toEqual([
      { name: "com.example.slots.Slot", isStatic: false, wildcard: false },
      { name: "com.example.util.Money.format", isStatic: true, wildcard: false },
      { name: "com.example.common", isStatic: false, wildcard: true },
    ]);
    expect(s.types).toEqual([
      { name: "OrderService", line: 6, exported: true, abstract: true },
      { name: "State", line: 9, exported: false, abstract: false },
    ]);
    expect(s.used).toEqual(["BaseService", "Delivery", "NEW"]);
  });
});

describe("JavaExtractor", () => {
  const x = new JavaExtractor();

  it("emits imports and same-package candidates; a runnable test is TESTED_BY what it uses", async () => {
    const svc = await x.extract(
      `${MAIN}/OrderService.java`,
      "package com.example.orders;\nimport com.example.slots.Slot;\nimport static org.junit.Assert.*;\npublic class OrderService { OrderRepository repo; }\n",
    );
    expect(svc.nodes.map((n) => [n.id, n.kind])).toEqual([
      [`${MAIN}/OrderService.java`, "Module"],
      [`${MAIN}/OrderService.java#OrderService`, "Type"],
    ]);
    expect(svc.edges.map((e) => [e.to, e.relation])).toEqual([
      ["spec:?com.example.orders.OrderRepository", "DEPENDS_ON"],
      ["spec:com.example.slots.Slot", "DEPENDS_ON"],
      ["spec:org.junit.Assert", "DEPENDS_ON"],
    ]);
    const spec = await x.extract(
      `${TEST}/OrderServiceSpecification.groovy`,
      "package com.example.orders\nclass OrderServiceSpecification extends BaseOrderSpecification {\n  def service = Mock(OrderService)\n}\n",
    );
    expect(spec.nodes[0]?.kind).toBe("Test");
    expect(spec.edges.every((e) => e.relation === "TESTED_BY")).toBe(true);
    const base = await x.extract(
      `${TEST}/BaseOrderSpecification.groovy`,
      "package com.example.orders\nabstract class BaseOrderSpecification { OrderRepository repo }\n",
    );
    // a base class of tests is no test of its own: it depends on what it uses
    expect(base.nodes[0]?.kind).toBe("Module");
    expect(base.edges.map((e) => e.relation)).toEqual(["DEPENDS_ON"]);
  });
});

describe("JavaResolver", () => {
  const files = new Set([
    "src/main/java/com/example/orders/Order.java",
    "src/test/java/com/example/orders/Samples.java",
    "billing/src/main/java/com/example/orders/Order.java",
    "README.md",
  ]);
  const r = new JavaResolver(files);
  const from = "src/main/java/com/example/orders/OrderService.java";

  it("maps classes, nested classes and static members to files of the tree", () => {
    expect(r.resolve(from, "com.example.orders.Order")).toBe("src/main/java/com/example/orders/Order.java");
    expect(r.resolve(from, "com.example.orders.Order.Line")).toBe(
      "src/main/java/com/example/orders/Order.java",
    );
    expect(r.resolve("billing/src/main/java/com/example/X.java", "com.example.orders.Order")).toBe(
      "billing/src/main/java/com/example/orders/Order.java",
    );
    expect(r.resolve(from, "?com.example.orders.Samples")).toBe(
      "src/test/java/com/example/orders/Samples.java",
    );
  });

  it("keeps a class outside the tree as its package and drops a candidate outside it", () => {
    expect(r.resolve(from, "org.springframework.web.bind.annotation.GetMapping")).toBe(
      "pkg:org.springframework.web.bind.annotation",
    );
    expect(r.resolve(from, "?com.example.orders.String")).toBeNull();
    expect(r.resolve("src/main/java/com/example/orders/Order.java", "?com.example.orders.Order")).toBeNull();
  });
});

describe("JVM graph of a project", () => {
  let sb: Sandbox;
  let rt: Runtime | undefined;
  const write = (rel: string, content: string) => {
    mkdirSync(join(sb.project, rel, ".."), { recursive: true });
    writeFileSync(join(sb.project, rel), content);
  };
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: sb.project,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  beforeEach(() => {
    sb = sandbox();
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    write("build.gradle", "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
    write(`${MAIN}/Order.java`, "package com.example.orders;\npublic class Order {}\n");
    write(
      `${MAIN}/OrderRepository.java`,
      "package com.example.orders;\npublic interface OrderRepository { Order find(); }\n",
    );
    write(
      `${MAIN}/web/OrderController.java`,
      "package com.example.orders.web;\nimport com.example.orders.*;\npublic class OrderController { OrderRepository repo; }\n",
    );
    write(
      `${TEST}/BaseOrderSpecification.groovy`,
      "package com.example.orders\nabstract class BaseOrderSpecification { OrderRepository repo }\n",
    );
    write(
      `${TEST}/FindOrderSpecification.groovy`,
      "package com.example.orders\nclass FindOrderSpecification extends BaseOrderSpecification {}\n",
    );
    write(
      "src/test/java/com/example/orders/web/OrderControllerTest.java",
      "package com.example.orders.web;\nimport org.junit.jupiter.api.Test;\nclass OrderControllerTest { OrderController c; }\n",
    );
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    sb.cleanup();
  });

  it("detects a Spring Gradle build", async () => {
    const a = new JavaAdapter();
    expect(await a.detect(sb.project)).toEqual({
      detected: true,
      stacks: ["gradle", "java", "spring"],
      evidence: ["build.gradle"],
    });
    expect(a.defaultCommands().test).toBe("./gradlew test");
  });

  it("finds the tests of a change through a base test class and a wildcard import", async () => {
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const { snapshot } = await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { from: `${MAIN}/OrderRepository.java`, to: `${MAIN}/Order.java`, relation: "DEPENDS_ON" },
        {
          from: `${MAIN}/web/OrderController.java`,
          to: `${MAIN}/OrderRepository.java`,
          relation: "DEPENDS_ON",
        },
        {
          from: `${TEST}/BaseOrderSpecification.groovy`,
          to: `${MAIN}/OrderRepository.java`,
          relation: "DEPENDS_ON",
        },
        {
          from: `${TEST}/BaseOrderSpecification.groovy`,
          to: `${TEST}/FindOrderSpecification.groovy`,
          relation: "TESTED_BY",
        },
      ]),
    );
    // candidates the tree does not have leave no trace
    expect(snapshot.edges.some((e) => e.to.includes("?") || e.to.includes("Order.find"))).toBe(false);
    expect(impactOf(snapshot, [`${MAIN}/Order.java`]).tests).toEqual([
      `${TEST}/FindOrderSpecification.groovy`,
      "src/test/java/com/example/orders/web/OrderControllerTest.java",
    ]);
  });
});
