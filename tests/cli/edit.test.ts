import { readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editableFile } from "../../src/artifacts/editable.ts";
import { run } from "../../src/cli/main.ts";
import { ACTOR, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0005 §3 from the terminal: `jarvis edit`, `jarvis approve` and `jarvis status` on a person's edit. */
let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "";
  let err = "";
  const sink = (add: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        add(String(c));
        cb();
      },
    });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...env } },
  });
  return { code, out, err };
}

/** A run with an agent's spec, its workspace the project. */
async function runWithSpec() {
  const rt = await testRuntime(sb);
  try {
    const r = rt.runs.create({
      task: "ABC-42",
      workflow: "spec",
      owner: ACTOR,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: rt.loaded.config.dataClass,
    });
    const spec = rt.artifacts.put({
      runId: r.id,
      type: "spec",
      name: "spec.json",
      content: '{\n  "summary": "payments-service retries twice"\n}',
      mediaType: "application/json",
      provenance: { kind: "agent", agentId: "spec", modelCallRefs: ["event:1"], toolCallRefs: [] },
      stepId: "spec",
      iteration: 1,
    });
    return { run: r, spec };
  } finally {
    await rt.close();
  }
}

describe("jarvis edit", () => {
  it("opens the document in $EDITOR; the change is the next version, edited by the person", async () => {
    const { run: r, spec } = await runWithSpec();
    const edited = await jarvis(["edit", r.id], { EDITOR: "sed -i s/twice/three\\ times/" });
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("spec/spec.json@2: edited by me@corp (from @1)");
    expect(readFileSync(editableFile(r, spec), "utf8")).toContain("three times");

    const status = await jarvis(["status", r.id]);
    expect(status.out).toContain("✎ edited by me@corp");
    expect(status.out).toContain("jarvis edit");

    const unchanged = await jarvis(["edit", r.id, "spec"], { EDITOR: "true" });
    expect(unchanged.out).toContain("spec/spec.json@2: no change");
  });

  it("--no-open prints the file; a type that is not edited as a file is refused", async () => {
    const { run: r, spec } = await runWithSpec();
    const printed = await jarvis(["edit", r.id, "--no-open"]);
    expect(printed.out.trim()).toBe(editableFile(r, spec));
    const refused = await jarvis(["edit", r.id, "research"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('"research" is not edited as a file');
  });

  it("jarvis approve takes the edit of the file first and decides on it", async () => {
    const { run: r, spec } = await runWithSpec();
    await jarvis(["edit", r.id, "--no-open"]);
    writeFileSync(editableFile(r, spec), '{ "summary": "payments-service retries once" }');
    const approved = await jarvis(["approve", r.id, "--type", "spec"]);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain("spec/spec.json@2: your edit of the file is recorded");
    expect(approved.out).toContain("approve: spec/spec.json@2 by me@corp");
  });
});
