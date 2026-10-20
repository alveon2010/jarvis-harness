import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
const SECRET = "payments-service-secret-7c6b5a4d3e2f";
const ENV = { PATH: process.env.PATH ?? "", JARVIS_KEYCHAIN_BACKEND: "file", PAYMENTS_TOKEN: SECRET };

beforeEach(() => {
  sb = sandbox();
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
actor: { id: me@corp }
models:
  local: { provider: openai-compatible, baseUrl: "http://127.0.0.1:9", model: local, egress: private, contextWindow: 32000, maxOutput: 2000, auth: { type: bearer, token: "keychain:local" } }
  cloud: { provider: openai-compatible, baseUrl: "https://api.example.com", model: cloud, egress: cloud, contextWindow: 32000, maxOutput: 2000, auth: { type: bearer, token: "env:CLOUD_KEY" } }
`,
  );
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1
dataClass: confidential
workspace: { mode: cwd }
mcp:
  servers:
    design:
      transport: http
      url: https://mcp.example.com/design
      network: internet
    wiki:
      transport: http
      url: https://wiki.corp.local/mcp
      network: intranet
    files:
      transport: stdio
      command: node
      network: none
egressExceptions:
  - server: design
    reason: design mockups are read for the UI steps
security:
  secretEnv: [PAYMENTS_TOKEN]
  deniedPaths: ["config/prod/**"]
  secretPatterns:
    - { name: shop-key, regex: "\\\\bshp_[A-Za-z0-9]{24}\\\\b" }
    - { name: too-broad, regex: "[a-z]+-api" }
`,
  );
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        append(String(c));
        cb();
      },
    });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    context: { cwd: sb.project, homeDir: sb.home, env: ENV },
  });
  return { code, out, err };
}

/** An artifact with a secret in it, written through the runtime as a step would write it. */
async function writeArtifactWithSecret(): Promise<string> {
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: ENV });
  const rt = createRuntime(loaded, { env: ENV });
  try {
    const runId = rt.runs.create({
      task: "ABC-42",
      workflow: "sdd",
      owner: { kind: "user", id: "me@corp", verified: false },
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "confidential",
    }).id;
    const a = rt.artifacts.put({
      runId,
      stepId: "spec",
      type: "spec",
      name: "spec.md",
      content: `# Spec\n\nCall payments-service with ${SECRET}.\n`,
      provenance: { kind: "agent", agentId: "spec" },
    });
    return rt.artifacts.text(a);
  } finally {
    await rt.close();
  }
}

describe("redactions at the artifact boundary and in doctor (ADR-0010 §4)", () => {
  it("masks a secret before the artifact is stored and counts it; doctor shows the counts", async () => {
    const stored = await writeArtifactWithSecret();
    expect(stored).not.toContain(SECRET);
    expect(stored).toMatch(/Call payments-service with \[REDACTED:literal:[0-9a-f]{8}\]\./);

    const doctor = await jarvis(["--json", "doctor"]);
    expect(doctor.out).not.toContain(SECRET);
    const report = JSON.parse(doctor.out) as {
      checks: Array<{ id: string; status: string; detail: string }>;
      redactions: {
        last24h: { total: number; byBoundary: Record<string, number> };
        last7d: { total: number };
      };
    };
    expect(report.redactions.last24h.total).toBe(1);
    expect(report.redactions.last24h.byBoundary).toEqual({ artifact: 1 });
    expect(report.redactions.last7d.total).toBe(1);
    const check = report.checks.find((c) => c.id === "redactions");
    expect(check?.detail).toBe(
      "24h 1 in 1 run (artifact 1; literal ×1) · 7d 1 in 1 run (artifact 1; literal ×1)",
    );

    const text = await jarvis(["doctor"]);
    expect(text.out).toMatch(/redactions\s+24h 1 in 1 run \(artifact 1; literal ×1\)/);
  });
});

describe("jarvis doctor --security", () => {
  it("reports redactions, egress, exceptions, telemetry, secrets, denied paths and project patterns", async () => {
    await writeArtifactWithSecret();
    const r = await jarvis(["--json", "doctor", "--security"]);
    expect(r.out).not.toContain(SECRET);
    const report = JSON.parse(r.out) as {
      dataClass: string;
      redactions: { last24h: { total: number } };
      models: Array<{ id: string; egress: string; allowed: boolean }>;
      servers: Array<{ id: string; network: string; allowed: boolean; exception?: string }>;
      exceptions: Array<{ server: string; network: string; reason: string }>;
      telemetryExport: { enabled: boolean; payloads: boolean };
      secrets: Array<{ path: string; ref: string; backend: string }>;
      deniedPaths: { builtIn: number; project: string[] };
      secretEnv: string[];
      secretPatterns: Array<{ name: string; ok: boolean; problem?: string }>;
      checks: Array<{ id: string; status: string }>;
      ok: boolean;
    };
    expect(report.dataClass).toBe("confidential");
    expect(report.redactions.last24h.total).toBe(1);
    expect(report.models).toEqual([
      { id: "local", egress: "private", allowed: true },
      expect.objectContaining({ id: "cloud", egress: "cloud", allowed: false }),
    ]);
    // a server without network access is not listed
    expect(report.servers.map((s) => s.id)).toEqual(["design", "wiki"]);
    expect(report.servers[0]).toMatchObject({ network: "internet", allowed: true });
    expect(report.servers[0]?.exception).toContain("design mockups");
    expect(report.exceptions).toEqual([
      { server: "design", network: "internet", reason: "design mockups are read for the UI steps" },
    ]);
    expect(report.telemetryExport).toMatchObject({ enabled: false, payloads: false });
    expect(report.secrets).toEqual([
      { path: "models.local.auth.token", ref: "keychain:local", backend: "keychain" },
      { path: "models.cloud.auth.token", ref: "env:CLOUD_KEY", backend: "env" },
    ]);
    expect(report.deniedPaths.project).toEqual(["config/prod/**"]);
    expect(report.deniedPaths.builtIn).toBeGreaterThan(10);
    expect(report.secretEnv).toEqual(["PAYMENTS_TOKEN"]);
    expect(report.secretPatterns[0]).toEqual({ name: "shop-key", ok: true });
    expect(report.secretPatterns[1]?.problem).toContain("also matches ordinary text");
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(status["egress:model:cloud"]).toBe("warn");
    expect(status["egress:exception:design"]).toBe("warn");
    expect(status["secret:models.cloud.auth.token"]).toBe("warn");
    expect(status["secret:models.local.auth.token"]).toBe("ok");
    expect(status["pattern:too-broad"]).toBe("warn");
    expect(report.ok).toBe(true);
    // a focused report: no environment checks
    expect(status.node).toBeUndefined();

    const text = await jarvis(["doctor", "--security"]);
    expect(text.code).toBe(0);
    for (const section of [
      "jarvis doctor --security",
      "models by egress",
      "MCP servers with network access",
      "egress exceptions in force",
      "project secret patterns",
    ])
      expect(text.out).toContain(section);
    expect(text.out).toContain("env:CLOUD_KEY — not a keychain: reference");
  });

  it("fails on a project pattern that does not compile", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      `version: 1
workspace: { mode: cwd }
security:
  secretPatterns:
    - { name: broken, regex: "(unclosed" }
`,
    );
    const r = await jarvis(["doctor", "--security"]);
    expect(r.code).toBe(1);
    // the configuration does not compile the patterns; the runtime would fail on it at the first run
    expect(r.out).toMatch(/FAIL\s+broken\s+does not compile/);
  });
});
