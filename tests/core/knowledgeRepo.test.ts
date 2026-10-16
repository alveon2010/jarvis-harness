import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Candidate, targetOf } from "../../src/app/candidates.ts";
import { docsOf, glossaryOf } from "../../src/app/knowledgeView.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { forgetLayouts, layoutOf } from "../../src/core/paths.ts";
import { recordKnowledgeRepoInputs } from "../../src/evals/inputs.ts";
import { loadKnowledgeDocs } from "../../src/knowledge/resolver.ts";
import { loadGlossary } from "../../src/knowledge/retrieval/glossary.ts";
import { knowledgeRootsOf } from "../../src/knowledge/sources.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0025 §1–3: services without .jarvis, their Jarvis files in a knowledge repository next to them. */
let sb: Sandbox;
let repos: string;
let meta: string;

const META = `version: 1
stack: [java, spring, kafka, gradle]
tools: { local: { test: ./gradlew test } }
services:
  orders-api: {}
  delivery-slots-api:
    repo: slots-service
    tools: { local: { test: "TZ=Europe/Moscow ./gradlew test" } }
  notify-api:
    stack: [kotlin, spring]
`;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

function repo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

beforeEach(() => {
  forgetLayouts();
  sb = sandbox();
  repos = join(sb.root, "repos");
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  meta = repo("jarvis-knowledge");
  sb.write("repos/jarvis-knowledge/.jarvis/project.yaml", META);
  sb.write(
    "repos/jarvis-knowledge/knowledge/landscape.md",
    "# Landscape\n\nOrders, delivery slots, notifications.\n",
  );
  sb.write(
    "repos/jarvis-knowledge/knowledge/glossary.md",
    "| термин | синонимы | символы | источники | статус | обновлено |\n|---|---|---|---|---|---|\n| слот | окно доставки | `DeliverySlot` | | draft | 2026-10-16 |\n",
  );
  sb.write(
    "repos/jarvis-knowledge/knowledge/services/orders-api/architecture.md",
    "# orders-api\n\nThe order event goes to orders.created.\n",
  );
  sb.write(
    "repos/jarvis-knowledge/.jarvis/workflows/quick.yaml",
    "name: quick\nentry: a\nsteps:\n  - id: a\n    kind: deterministic\n    tool: artifact.write\n    args: { type: note, name: n.md, content: x }\n    transitions: { onSuccess: DONE }\n",
  );
  git(meta, ["add", "-A"]);
  git(meta, ["commit", "-q", "-m", "init"]);
  repo("orders-api");
  repo("slots-service");
});
afterEach(() => {
  forgetLayouts();
  sb.cleanup();
});

const load = (cwd: string, env: NodeJS.ProcessEnv = {}) => loadConfig({ cwd, homeDir: sb.home, env });

describe("a service of a knowledge repository", () => {
  it("is found next to it by folder name, its config the shared one with its own over it", async () => {
    const loaded = await load(join(repos, "orders-api"));
    expect(loaded.meta?.service).toBe("orders-api");
    expect(loaded.meta?.root).toBe(meta);
    expect(loaded.project?.root).toBe(join(repos, "orders-api"));
    expect(loaded.project?.knowledgeDir).toBe(join(meta, "knowledge", "services", "orders-api"));
    expect(loaded.config.tools.local.test).toBe("./gradlew test");
    expect(loaded.config.stack).toEqual(["java", "spring", "kafka", "gradle"]);
    // nothing of Jarvis in the service's repository
    expect(existsSync(join(repos, "orders-api", ".jarvis"))).toBe(false);

    const slots = await load(join(repos, "slots-service"));
    expect(slots.meta?.service).toBe("delivery-slots-api");
    expect(slots.config.tools.local.test).toBe("TZ=Europe/Moscow ./gradlew test");
    expect(slots.sources["tools.local.test"]).toMatch(/#services\.delivery-slots-api$/);
  });

  it("a repository laid out elsewhere on this machine: repos.<service> of the personal config", async () => {
    const elsewhere = join(sb.root, "work", "notify");
    mkdirSync(elsewhere, { recursive: true });
    git(elsewhere, ["init", "-q"]);
    sb.write(
      "home/.jarvis/config.yaml",
      `version: 1\nactor: { id: dev@example.com }\nknowledgeRepo: ${meta}\nrepos: { notify-api: ${elsewhere} }\n`,
    );
    const loaded = await load(elsewhere);
    expect(loaded.meta?.service).toBe("notify-api");
    expect(loaded.config.stack).toEqual(["kotlin", "spring"]);
  });

  it("a repository the map does not name: a warning that says what to add, and no service", async () => {
    repo("billing-api");
    const loaded = await load(join(repos, "billing-api"));
    expect(loaded.meta).toBeUndefined();
    expect(loaded.warnings.join("\n")).toContain("add services.billing-api to");
  });

  it("a repository with a .jarvis of its own stays on its own", async () => {
    sb.write("repos/orders-api/.jarvis/project.yaml", "version: 1\n");
    const loaded = await load(join(repos, "orders-api"));
    expect(loaded.meta).toBeUndefined();
    expect(loaded.project?.knowledgeDir).toBe(join(repos, "orders-api", ".jarvis", "knowledge"));
  });

  it("the knowledge repository itself: the shared config, and every service's repository", async () => {
    const loaded = await load(meta);
    expect(loaded.meta?.service).toBeUndefined();
    expect(loaded.meta?.repos).toEqual({
      "orders-api": join(repos, "orders-api"),
      "delivery-slots-api": join(repos, "slots-service"),
      "notify-api": join(repos, "notify-api"),
    });
    expect(loaded.project?.knowledgeDir).toBe(join(meta, "knowledge"));
  });

  it("knowledge, glossary and workflows come from the knowledge repository, a run's checkout included", async () => {
    const orders = join(repos, "orders-api");
    const loaded = await load(orders);
    const docs = loadKnowledgeDocs(knowledgeRootsOf(loaded, orders)).map((d) => d.name);
    expect(docs).toEqual(["architecture.md", "common/landscape.md"]);
    expect(loadGlossary(orders).map((e) => e.term)).toEqual(["слот"]);
    expect(loadWorkflows(orders).has("quick")).toBe(true);

    // a run's clone names the repository it came from: the same knowledge
    const checkout = join(sb.root, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "jarvis-main"), `${orders}\n`);
    expect(layoutOf(checkout).knowledgeDir).toBe(join(meta, "knowledge", "services", "orders-api"));
    expect(loadKnowledgeDocs(knowledgeRootsOf(loaded, checkout)).map((d) => d.name)).toContain(
      "architecture.md",
    );

    // the pages name the documents by a path that joins with the root back to the file
    const views = await docsOf(knowledgeRootsOf(loaded, orders));
    expect(views.map((d) => d.path)).toEqual([
      "../jarvis-knowledge/knowledge/services/orders-api/architecture.md",
      "../jarvis-knowledge/knowledge/landscape.md",
    ]);
    expect(views[0]?.edited).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await glossaryOf(orders, false)).rows.map((r) => r.term)).toEqual(["слот"]);
  });

  it("its agents get its neighbours from the catalog, as a shared document", async () => {
    const orders = join(repos, "orders-api");
    const loaded = await load(orders);
    const contracts = (service: string, extra: object) =>
      JSON.stringify({ version: 1, service, serves: [], calls: [], produces: [], consumes: [], ...extra });
    sb.write(
      "repos/jarvis-knowledge/knowledge/services/orders-api/contracts.json",
      contracts("orders-api", {
        produces: [{ topic: "orders.created", senders: ["Publisher"], file: "P.java" }],
      }),
    );
    sb.write(
      "repos/jarvis-knowledge/knowledge/services/notify-api/contracts.json",
      contracts("notify-api", { consumes: [{ topic: "orders.created", file: "L.kt" }] }),
    );
    const doc = loadKnowledgeDocs(knowledgeRootsOf(loaded, orders)).find(
      (d) => d.name === "common/neighbours.md",
    );
    expect(doc?.text).toContain("- topic `orders.created` — notify-api");
  });

  it("an accepted module goes to the service's folder of the knowledge repository", async () => {
    const orders = join(repos, "orders-api");
    await load(orders);
    const c = {
      name: "src/orders",
      doc: { kind: "knowledge", module: "src/orders", title: "module src/orders" },
    };
    expect(targetOf(orders, c as unknown as Candidate, undefined)).toBe(
      join(meta, "knowledge", "services", "orders-api", "module-src-orders.md"),
    );
  });

  it("jarvis init in a service creates nothing in its repository", async () => {
    const orders = join(repos, "orders-api");
    const report = await runInit(
      { cwd: orders, env: {}, homeDir: sb.home, out: undefined as never },
      { projectOnly: true },
    );
    expect(report.service).toEqual({ name: "orders-api", knowledgeRepo: meta });
    expect(report.created).toEqual([]);
    expect(existsSync(join(orders, ".jarvis"))).toBe(false);
  });

  it("a run records the knowledge repository's commit and its files changed since", async () => {
    const orders = join(repos, "orders-api");
    await load(orders);
    sb.write("repos/jarvis-knowledge/knowledge/services/orders-api/module-orders.md", "# orders\n");
    sb.write("repos/jarvis-knowledge/knowledge/services/notify-api/architecture.md", "# notify\n");
    const inputs = await recordKnowledgeRepoInputs(orders);
    expect(inputs?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(inputs?.service).toBe("orders-api");
    // this service's documents, not another's
    expect(Object.keys(inputs?.files ?? {})).toEqual(["knowledge/services/orders-api/module-orders.md"]);
  });
});
