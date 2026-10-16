import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime } from "../../src/app/runtime.ts";
import { deliveryOrder, setCliLauncher, subtasksOf } from "../../src/app/subtasks.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { forgetLayouts } from "../../src/core/paths.ts";
import { runPage } from "../../src/ui/model.ts";
import { runContent } from "../../src/ui/pages.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/**
 * ADR-0025 §6: a task across services — the master in the knowledge repository splits it, the
 * subtasks run in the services' repositories, the master waits for them and checks the contract.
 * The models' steps are replaced by fixed artifacts; the subtasks' processes run in this one.
 */
let sb: Sandbox;
let repos: string;
let meta: string;
let launches: Array<{ args: readonly string[]; cwd: string }>;

const SPLIT = JSON.stringify({
  summary: "orders-api sends the slot, notify-api shows it",
  subtasks: [
    { key: "1", service: "orders-api", task: "Put deliverySlotId into orders.created", requirements: ["R1"] },
    {
      key: "2",
      service: "notify-api",
      task: "Show the slot window in the SMS",
      requirements: ["R2"],
      deliverAfter: ["1"],
    },
  ],
  contract: [
    {
      kind: "topic",
      id: "orders.created",
      change: "+ deliverySlotId, optional",
      producer: "orders-api",
      consumers: ["notify-api"],
    },
  ],
});

/** The master's workflow with the models' steps as fixed artifacts. */
const MASTER = `name: sdd-cross
entry: spec
steps:
  - id: spec
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.json, content: '{"title":"Delivery slot","requirements":[]}' }
    outputs: [spec]
    transitions: { onSuccess: split }
  - id: split
    kind: deterministic
    tool: artifact.write
    args: { type: split, name: split.json, content: '${SPLIT}' }
    outputs: [split]
    transitions: { onSuccess: spawn }
  - id: spawn
    kind: deterministic
    tool: cross.spawn
    transitions: { onSuccess: wait }
  - id: wait
    kind: deterministic
    tool: cross.wait
    transitions: { onSuccess: contract-check }
  - id: contract-check
    kind: deterministic
    tool: cross.check
    outputs: [contract-check]
    transitions: { onSuccess: approve-delivery }
  - id: approve-delivery
    kind: approval
    artifactType: contract-check
    transitions: { onSuccess: DONE }
`;

/** A subtask's sdd from its impact, as fixed artifacts. */
const SUBTASK = `name: sdd
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args: { type: impact, name: impact.json, content: '{"affected":[]}' }
    outputs: [impact]
    transitions: { onSuccess: DONE }
`;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
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
  sb.write(
    "repos/jarvis-knowledge/.jarvis/project.yaml",
    "version: 1\nworkspace: { mode: cwd }\ncrossRepos: { maxParallel: 1 }\nservices:\n  orders-api: {}\n  notify-api: {}\n",
  );
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd-cross.yaml", MASTER);
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml", SUBTASK);
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

/** The next process the master or a subtask started, run here. */
async function next() {
  const l = launches.shift();
  if (!l) throw new Error("nothing was started");
  return { ...l, result: await jarvis(l.cwd, l.args) };
}

describe("a task across services", () => {
  it("splits, runs the subtasks one by one in their repositories, then the master checks the contract", async () => {
    const master = await jarvis(meta, [
      "--json",
      "work",
      "ABC-42 delivery slot in the order event",
      "--workflow",
      "sdd-cross",
    ]);
    // the master parks waiting for its subtasks; the first one (of one slot) is started in orders-api
    expect(master.out).toContain("SUSPENDED");
    expect(launches.map((l) => [l.args.slice(0, 2).join(" "), l.args[3], l.cwd])).toEqual([
      ["subtask run", "1", join(repos, "orders-api")],
    ]);

    const first = await next();
    expect(first.result.code).toBe(0);
    // its slot freed: the second starts
    expect(launches.map((l) => [l.args[3], l.cwd])).toEqual([["2", join(repos, "notify-api")]]);
    const second = await next();
    expect(second.result.code).toBe(0);
    // every subtask done: the master goes on in the knowledge repository
    expect(launches.map((l) => [l.args[0], l.cwd])).toEqual([["resume", meta]]);
    const resumed = await next();
    expect(resumed.result.code).toBe(10); // the delivery gate

    let childId: string | undefined;
    const loaded = await loadConfig({ cwd: meta, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const m = rt.runs.list({ includeTerminal: true }).find((r) => r.workflow === "sdd-cross");
      if (!m) throw new Error("no master");
      expect(m.state).toBe("WAITING_HUMAN");
      const views = subtasksOf(rt, m);
      expect(views.map((v) => [v.subtask.key, v.subtask.service, v.state])).toEqual([
        ["1", "orders-api", "COMPLETED"],
        ["2", "notify-api", "COMPLETED"],
      ]);
      // the subtask's run knows its part and the contract
      expect(views[1]?.run?.task).toContain("subtask 2 of 2, notify-api");
      childId = views[1]?.run?.id;
      expect(views[1]?.run?.task).toContain(
        "topic orders.created: + deliverySlotId, optional — orders-api sends; notify-api read",
      );
      const check = JSON.parse(
        rt.artifacts.text(rt.artifacts.listLatest(m.id, "contract-check")[0] as never),
      ) as {
        ok: boolean;
        items: Array<{ producerSide: { service: string; status: string } }>;
      };
      // the code does not send the topic: the check says so, no model involved
      expect(check.items[0]?.producerSide).toEqual({ service: "orders-api", status: "missing" });
      expect(check.ok).toBe(false);
      // the master's page: its subtasks and the contract, each side
      const page = await runPage(rt, createEngine(rt), m, { homeDir: sb.home });
      const body = runContent(page, Date.now()).value;
      expect(body).toContain("Subtasks");
      expect(body).toContain("2 of 2 done");
      expect(body).toContain("✗ orders-api");
      const child = await runPage(rt, createEngine(rt), views[1]?.run as never, { homeDir: sb.home });
      expect(runContent(child, Date.now()).value).toContain("subtask 2 of 2 · notify-api of");
    } finally {
      rt.close();
    }

    const masterId = second.args[2] as string;
    const masterStatus = await jarvis(meta, ["status", masterId.slice(4, 12)]);
    expect(masterStatus.out).toMatch(/subtasks\s+1 orders-api\s+COMPLETED/);
    const childStatus = await jarvis(join(repos, "notify-api"), ["status", (childId as string).slice(4, 12)]);
    expect(childStatus.out).toMatch(/subtask\s+2 of 2 · notify-api of ABC-42/);
    const list = await jarvis(meta, ["subtask", "list", (second.args[2] as string).slice(4, 12)]);
    expect(list.out).toMatch(/1\s+orders-api\s+COMPLETED/);
  });

  it("a subtask dropped by a person: the master goes on without it", async () => {
    await jarvis(meta, ["work", "ABC-43", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    await next(); // orders-api completes; notify-api is started
    launches.length = 0;
    const dropped = await jarvis(meta, ["subtask", "drop", masterId.slice(4, 12), "notify-api"]);
    expect(dropped.code).toBe(0);
    expect(launches.map((l) => l.args[0])).toEqual(["resume"]);
  });

  it("delivers the producer before its consumers", () => {
    const order = deliveryOrder([
      { key: "1", service: "notify-api", task: "", requirements: [], deliverAfter: ["2"] },
      { key: "2", service: "orders-api", task: "", requirements: [], deliverAfter: [] },
    ]);
    expect(order.map((s) => s.service)).toEqual(["orders-api", "notify-api"]);
  });

  it("refuses to run in a service: the master's place is the knowledge repository", async () => {
    const r = await jarvis(join(repos, "orders-api"), ["work", "ABC-44", "--workflow", "sdd-cross"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("runs in the knowledge repository");
  });
});
