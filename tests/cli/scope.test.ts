import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { setCliLauncher } from "../../src/app/subtasks.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { forgetLayouts } from "../../src/core/paths.ts";
import { catalogOf, namedServices } from "../../src/knowledge/catalog.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/**
 * ADR-0025 §7: an sdd in a service whose impact ties a requirement to a linked service stops at the
 * scope gate; one with nothing of the kind, or a repository of its own, goes on as before.
 */
let sb: Sandbox;
let repos: string;
let meta: string;
let launches: Array<{ args: readonly string[]; cwd: string }>;

const impact = (elsewhere: object[]) =>
  JSON.stringify({
    summary: "s",
    affected: [{ path: "src/Publisher.java", kind: "code", reason: "r" }],
    elsewhere,
  });

/** sdd from its impact on, the models' steps as fixed artifacts; the scope step comes from the layout. */
const SDD = (elsewhere: object[]) => `name: sdd
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args: { type: impact, name: impact.json, content: '${impact(elsewhere)}' }
    outputs: [impact]
    transitions: { onSuccess: plan }
  - id: plan
    kind: deterministic
    tool: noop
    transitions: { onSuccess: DONE }
`;

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });

function repo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

const contracts = (service: string, extra: object) =>
  JSON.stringify({ version: 1, service, serves: [], calls: [], produces: [], consumes: [], ...extra });

beforeEach(() => {
  forgetLayouts();
  sb = sandbox();
  repos = join(sb.root, "repos");
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  meta = repo("jarvis-knowledge");
  sb.write(
    "repos/jarvis-knowledge/.jarvis/project.yaml",
    "version: 1\nworkspace: { mode: cwd, allowWrites: true }\nservices:\n  orders-api: {}\n  notify-api: {}\n  billing-api: {}\n",
  );
  sb.write(
    "repos/jarvis-knowledge/knowledge/services/orders-api/contracts.json",
    contracts("orders-api", {
      produces: [{ topic: "orders.created", senders: ["Publisher"], file: "src/Publisher.java" }],
    }),
  );
  sb.write(
    "repos/jarvis-knowledge/knowledge/services/notify-api/contracts.json",
    contracts("notify-api", { consumes: [{ topic: "orders.created", file: "Listener.kt" }] }),
  );
  repo("orders-api");
  repo("notify-api");
  launches = [];
  setCliLauncher(({ args, cwd }) => launches.push({ args, cwd }));
});
afterEach(() => {
  setCliLauncher(undefined);
  forgetLayouts();
  sb.cleanup();
});

async function jarvis(cwd: string, args: readonly string[]) {
  let out = "";
  const sink = new Writable({
    write(c, _e, cb) {
      out += String(c);
      cb();
    },
  });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink, err: sink },
    context: { cwd, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", JARVIS_INTERACTIVE: "off" } },
  });
  return { code, out };
}

const short = (r: { id: string } | undefined) => (r ? r.id.slice(4, 12) : "");

async function lastRun(cwd: string) {
  const loaded = await loadConfig({ cwd, homeDir: sb.home, env: {} });
  const rt = createRuntime(loaded, { env: {} });
  try {
    return rt.runs.list({ includeTerminal: true }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    rt.close();
  }
}

describe("the scope gate of an sdd in a service", () => {
  it("a requirement of a linked service stops it; --single goes on and is not asked again", async () => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml",
      SDD([{ requirement: "R2", service: "notify-api", why: "the SMS" }]),
    );
    const orders = join(repos, "orders-api");
    const r = await jarvis(orders, ["work", "ABC-42 slot in the event"]);
    expect(r.code).toBe(10);
    expect(r.out).toContain("jarvis scope");
    const [waiting] = await lastRun(orders);
    expect(waiting?.waitingFor?.kind).toBe("scope");

    const shown = await jarvis(orders, ["scope", short(waiting)]);
    expect(shown.out).toMatch(/R2\s+notify-api\s+orders\.created/);
    const single = await jarvis(orders, ["scope", short(waiting), "--single", "--resume"]);
    expect(single.code).toBe(0);
    expect((await lastRun(orders))[0]?.state).toBe("COMPLETED");
  });

  it("--cross: a master in the knowledge repository takes the run, which ends", async () => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml",
      SDD([{ requirement: "R2", service: "notify-api", why: "the SMS" }]),
    );
    const orders = join(repos, "orders-api");
    await jarvis(orders, ["work", "ABC-42 slot in the event"]);
    const [waiting] = await lastRun(orders);
    const cross = await jarvis(orders, ["scope", short(waiting), "--cross"]);
    expect(cross.code).toBe(0);
    const runs = await lastRun(orders);
    const master = runs.find((x) => x.workflow === "sdd-cross");
    expect(master?.workspace.repoRoot).toBe(meta);
    // past its research and the approved spec: the split, with the catalog made for it
    expect(master?.currentStep).toBe("split");
    const rt = createRuntime(await loadConfig({ cwd: meta, homeDir: sb.home, env: {} }), { env: {} });
    try {
      const catalog = rt.artifacts.listLatest(master?.id as string, "catalog")[0];
      expect(catalog && rt.artifacts.text(catalog)).toContain("# The services and their contracts");
    } finally {
      rt.close();
    }
    expect(runs.find((x) => x.id === waiting?.id)?.state).toBe("CANCELLED");
    expect(launches.map((l) => [l.args[0], l.cwd])).toEqual([["resume", meta]]);
  });

  it("a tie the catalog does not link is a warning, not a stop", async () => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml",
      SDD([{ requirement: "R3", service: "billing-api", why: "invoices" }]),
    );
    const orders = join(repos, "orders-api");
    const r = await jarvis(orders, ["work", "ABC-45"]);
    expect(r.code).toBe(0);
  });

  it("a repository of its own keeps sdd as it is: no scope step", () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\n");
    expect(
      loadWorkflows(sb.project)
        .get("sdd")
        ?.steps.some((s) => s.id === "scope"),
    ).toBe(false);
  });

  it("the builtin sdd of a service gets the scope step right after impact", async () => {
    const orders = join(repos, "orders-api");
    await loadConfig({ cwd: orders, homeDir: sb.home, env: {} });
    const steps = loadWorkflows(orders).get("sdd")?.steps ?? [];
    const at = steps.findIndex((s) => s.id === "impact");
    expect(steps[at]?.transitions.onSuccess).toBe("scope");
    expect(steps[at + 1]).toMatchObject({
      id: "scope",
      tool: "scope.check",
      transitions: { onSuccess: "plan" },
    });
  });

  it("New task: the task's names point at linked services", () => {
    const named = namedServices(
      catalogOf(meta),
      "orders.created gets the slot; the SMS of notify-api shows it",
      ["orders-api", "notify-api", "billing-api"],
    );
    expect(named).toEqual([
      { service: "notify-api", by: "its name" },
      { service: "orders-api", by: "sends orders.created" },
    ]);
  });
});
