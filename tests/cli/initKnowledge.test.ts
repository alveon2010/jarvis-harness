import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { forgetLayouts, layoutOf } from "../../src/core/paths.ts";
import { catalogOf } from "../../src/knowledge/catalog.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** `jarvis init --knowledge` and a knowledge repository with its files at the top, no `.jarvis/`. */
let sb: Sandbox;
let repos: string;
let meta: string;

function repo(name: string, files: Record<string, string> = {}): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [f, c] of Object.entries(files)) sb.write(`repos/${name}/${f}`, c);
  return dir;
}

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

beforeEach(() => {
  forgetLayouts();
  sb = sandbox();
  repos = join(sb.root, "repos");
  repo("orders-api", { "build.gradle": "" });
  repo("web-app", { "package.json": "{}", ".jarvis/project.yaml": "version: 1\n" });
  sb.write("repos/notes/readme.md", "not a repository\n");
  meta = join(repos, "jarvis-knowledge");
  mkdirSync(meta, { recursive: true });
});
afterEach(() => {
  forgetLayouts();
  sb.cleanup();
});

describe("jarvis init --knowledge", () => {
  it("makes the folder a knowledge repository: project.yaml at the top, the git repositories next to it mapped", async () => {
    const r = await jarvis(meta, ["init", "--knowledge"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(meta, ".jarvis"))).toBe(false);
    expect(existsSync(join(meta, ".git"))).toBe(true);
    expect(existsSync(join(meta, "knowledge", "README.md"))).toBe(true);
    const yaml = readFileSync(join(meta, "project.yaml"), "utf8");
    expect(yaml).toMatch(/^ {2}orders-api: \{\}\s+# gradle$/m);
    expect(yaml).toMatch(/^ {2}web-app: \{\}\s+# node — has its own \.jarvis\//m);
    expect(yaml).not.toContain("notes");
    expect(r.out).toContain("mv ../web-app/.jarvis/knowledge/* knowledge/services/web-app/");

    // a service finds it, and reads its configuration from the top
    const orders = await loadConfig({ cwd: join(repos, "orders-api"), homeDir: sb.home, env: {} });
    expect(orders.meta?.root).toBe(meta);
    expect(orders.meta?.service).toBe("orders-api");
    expect(orders.project?.configFile).toBe(join(meta, "project.yaml"));
    expect(layoutOf(join(repos, "orders-api")).knowledgeDir).toBe(
      join(meta, "knowledge", "services", "orders-api"),
    );
    // the knowledge repository itself is the meta project
    forgetLayouts();
    const top = await loadConfig({ cwd: meta, homeDir: sb.home, env: {} });
    expect(top.meta?.root).toBe(meta);
    expect(top.meta?.service).toBeUndefined();
    expect(Object.keys(top.meta?.repos ?? {}).sort()).toEqual(["orders-api", "web-app"]);
  });

  it("run again: nothing written over, the new repositories listed", async () => {
    await jarvis(meta, ["init", "--knowledge", "--project-only"]);
    const before = readFileSync(join(meta, "project.yaml"), "utf8");
    repo("billing-api", { "pom.xml": "" });
    const r = await jarvis(meta, ["init", "--knowledge", "--project-only"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(meta, "project.yaml"), "utf8")).toBe(before);
    expect(r.out).toContain("not in the map yet");
    expect(r.out).toMatch(/billing-api: \{\}\s+# maven/);
    expect(r.out).not.toMatch(/orders-api: \{\}/);
  });

  it("a repository with a .jarvis of its own is not made one", async () => {
    const r = await jarvis(join(repos, "web-app"), ["init", "--knowledge", "--project-only"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(repos, "web-app", "project.yaml"))).toBe(false);
  });
});

describe("a knowledge repository with its files at the top", () => {
  it("its workflows and catalog are read from the top", async () => {
    await jarvis(meta, ["init", "--knowledge", "--project-only"]);
    sb.write(
      "repos/jarvis-knowledge/workflows/quick.yaml",
      "name: quick\nentry: a\nsteps:\n  - id: a\n    kind: deterministic\n    tool: noop\n    transitions: { onSuccess: DONE }\n",
    );
    sb.write(
      "repos/jarvis-knowledge/knowledge/services/orders-api/contracts.json",
      JSON.stringify({
        version: 1,
        service: "orders-api",
        serves: [],
        calls: [],
        produces: [],
        consumes: [],
      }),
    );
    const orders = join(repos, "orders-api");
    await loadConfig({ cwd: orders, homeDir: sb.home, env: {} });
    expect(loadWorkflows(orders).has("quick")).toBe(true);
    expect([...catalogOf(meta).services.keys()]).toEqual(["orders-api"]);
  });

  it("a project.yaml at the top without a version and a map is not Jarvis's", async () => {
    const other = repo("tooling", { "project.yaml": "services: { a: {} }\n" });
    const loaded = await loadConfig({ cwd: other, homeDir: sb.home, env: {} });
    expect(loaded.meta).toBeUndefined();
    expect(loaded.project?.configFile).toBe(join(other, ".jarvis", "project.yaml"));
  });
});
