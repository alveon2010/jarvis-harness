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
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/**
 * In a knowledge repository there is no code: `jarvis research` and `jarvis spec` there are across
 * services (the catalog first) and go on as sdd-cross; `work` and `fix` are refused. The models' steps
 * are fixed artifacts.
 */
let sb: Sandbox;
let repos: string;
let meta: string;

const RESEARCH_CROSS = `name: research-cross
entry: catalog
next: sdd-cross
steps:
  - id: catalog
    kind: deterministic
    tool: cross.catalog
    outputs: [catalog]
    transitions: { onSuccess: research }
  - id: research
    kind: deterministic
    tool: artifact.write
    args: { type: research, name: research.json, content: '{"summary":"orders-api and notify-api"}' }
    outputs: [research]
    transitions: { onSuccess: DONE }
`;
const SDD_CROSS = `name: sdd-cross
entry: catalog
steps:
  - id: catalog
    kind: deterministic
    tool: cross.catalog
    outputs: [catalog]
    transitions: { onSuccess: research }
  - id: research
    kind: deterministic
    tool: artifact.write
    args: { type: research, name: research.json, content: '{"summary":"again"}' }
    outputs: [research]
    transitions: { onSuccess: spec }
  - id: spec
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.json, content: '{"title":"slot"}' }
    outputs: [spec]
    transitions: { onSuccess: DONE }
`;

function repo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
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
    "version: 1\nservices:\n  orders-api: {}\n  notify-api: {}\n",
  );
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/research-cross.yaml", RESEARCH_CROSS);
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd-cross.yaml", SDD_CROSS);
  repo("orders-api");
  repo("notify-api");
  setCliLauncher(() => {});
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

async function runs() {
  const rt = createRuntime(await loadConfig({ cwd: meta, homeDir: sb.home, env: {} }), { env: {} });
  try {
    return rt.runs
      .list({ includeTerminal: true, limit: 50 })
      .map((r) => ({
        r,
        artifacts: ["catalog", "research", "spec"].filter((t) => rt.artifacts.listLatest(r.id, t).length > 0),
      }));
  } finally {
    rt.close();
  }
}

describe("research in a knowledge repository", () => {
  it("is across services: the catalog first, in its working copy; it goes on as sdd-cross from the spec", async () => {
    const r = await jarvis(meta, ["research", "ABC-60 slot in the order event"]);
    expect(r.code).toBe(0);
    const [first] = await runs();
    expect(first?.r.workflow).toBe("research-cross");
    expect(first?.r.workspace).toMatchObject({ mode: "cwd", path: meta });
    expect(first?.artifacts).toEqual(["catalog", "research"]);

    const next = await jarvis(meta, ["continue", (first?.r.id as string).slice(4, 12)]);
    expect(next.code).toBe(0);
    expect(next.out).toContain("goes on as sdd-cross from spec");
    const master = (await runs()).find((x) => x.r.workflow === "sdd-cross");
    expect(master?.r.workspace).toMatchObject({ mode: "cwd", path: meta });
    expect(master?.r.state).toBe("COMPLETED");
    // its research and catalog came over; it did not research again
    expect(master?.artifacts).toEqual(["catalog", "research", "spec"]);
  });

  it("work and fix are refused there; research-cross is refused in a service", async () => {
    const work = await jarvis(meta, ["work", "ABC-61"]);
    expect(work.code).toBe(1);
    expect(work.out).toContain("the knowledge repository has no code to change");
    expect(work.out).toContain("--workflow sdd-cross");
    expect((await jarvis(meta, ["fix", "ABC-62"])).code).toBe(1);
    const inService = await jarvis(join(repos, "orders-api"), [
      "work",
      "ABC-63",
      "--workflow",
      "research-cross",
    ]);
    expect(inService.code).toBe(1);
    expect(inService.out).toContain("research-cross runs in the knowledge repository of the services");
  });
});
