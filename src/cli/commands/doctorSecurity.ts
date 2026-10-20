import type { DataClass, Egress, Network } from "../../core/config/schema.ts";
import { parseSecretRef } from "../../core/config/secrets.ts";
import { jarvisHome } from "../../core/paths.ts";
import { serverNetwork } from "../../mcp/provider.ts";
import { egressNotices, evaluateEgress, modelAllowed } from "../../security/policy/egress.ts";
import {
  formatRedactionStats,
  highEntropyBurst,
  type RedactionWindows,
} from "../../security/redactionStats.ts";
import { DEFAULT_DENIED_PATHS } from "../../security/redactor.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";
import { type Check, type CheckStatus, check, collectSecretRefs, readRedactions } from "./doctor.ts";

/**
 * `jarvis doctor --security` (ADR-0010 §4–5, ADR-0016): what leaves the machine and what is kept from
 * it, in one place — redaction counts, models by egress, MCP servers that reach a network, the egress
 * exceptions in force, telemetry export, secrets kept outside the keychain, denied paths, and the
 * project's own secret patterns tried on ordinary text.
 */
export interface SecurityReport {
  readonly dataClass: DataClass;
  readonly redactions?: RedactionWindows;
  readonly models: ReadonlyArray<{ id: string; egress: Egress; allowed: boolean; reason?: string }>;
  /** MCP servers whose network is not `none`. */
  readonly servers: ReadonlyArray<{
    id: string;
    network: Network;
    allowed: boolean;
    exception?: string;
    reason?: string;
  }>;
  readonly exceptions: ReadonlyArray<{ server: string; network: Network; reason: string }>;
  readonly telemetryExport: {
    enabled: boolean;
    network: Network;
    payloads: boolean;
    maxPayloadBytes: number;
    allowed: boolean;
    reason?: string;
  };
  readonly secrets: ReadonlyArray<{ path: string; ref: string; backend: "env" | "keychain" }>;
  readonly deniedPaths: { readonly builtIn: number; readonly project: readonly string[] };
  readonly secretEnv: readonly string[];
  readonly secretPatterns: ReadonlyArray<{ name: string; ok: boolean; problem?: string }>;
  readonly checks: readonly Check[];
  readonly ok: boolean;
}

/**
 * Ordinary text a project's pattern must leave alone: names, ids, a commit sha, a uuid, a path. A
 * pattern that matches it would mask what agents need to read.
 */
export const ORDINARY_TEXT: readonly string[] = [
  'const ORDER_STATUS = "pending";',
  'import { createOrder } from "../orders-api/client";',
  "commit 3f2a9c1d4b5e6f708192a3b4c5d6e7f809a1b2c3",
  "request id 123e4567-e89b-12d3-a456-426614174000",
  "docs/adr/0010-secret-redaction.md",
  "ABC-42: payments-service returns 502 on retry",
];

/** A project pattern (`security.secretPatterns`): it must compile and must not match empty or ordinary text. */
export function tryPattern(regex: string): { ok: boolean; problem?: string } {
  let re: RegExp;
  try {
    re = new RegExp(regex, "g");
  } catch (error) {
    return {
      ok: false,
      problem: `does not compile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (new RegExp(regex).test("")) return { ok: false, problem: "matches an empty string" };
  for (const line of ORDINARY_TEXT) {
    re.lastIndex = 0;
    const m = re.exec(line);
    if (m) return { ok: false, problem: `also matches ordinary text: "${m[0]}" in "${line}"` };
  }
  return { ok: true };
}

export async function runSecurityReport(ctx: CliContext): Promise<SecurityReport> {
  const loaded = await loadForCli(ctx);
  const config = loaded.config;
  const checks: Check[] = [];

  const redactions = readRedactions(jarvisHome(ctx.env, ctx.homeDir).dbFile);
  if (redactions) {
    checks.push(
      check("redactions:24h", "ok", "last 24h", formatRedactionStats(redactions.last24h)),
      highEntropyBurst(redactions.last24h)
        ? check(
            "redactions:7d",
            "warn",
            "last 7d",
            formatRedactionStats(redactions.last7d),
            "many high-entropy guesses: look at what the project keeps in code; `jarvis show <run>` lists their shapes",
          )
        : check("redactions:7d", "ok", "last 7d", formatRedactionStats(redactions.last7d)),
    );
  } else checks.push(check("redactions", "ok", "redactions", "no journal yet"));

  const egress = evaluateEgress(config);
  const models = Object.entries(config.models).map(([id, model]) => {
    const decision = egress.models.find((m) => m.id === id);
    const allowed = modelAllowed(config.dataClass, model.egress);
    return { id, egress: model.egress, allowed, ...(decision?.reason ? { reason: decision.reason } : {}) };
  });
  for (const m of models)
    checks.push(
      check(
        `egress:model:${m.id}`,
        m.allowed ? "ok" : "warn",
        m.id,
        m.allowed ? `egress ${m.egress}` : (m.reason ?? `egress ${m.egress} is not allowed`),
      ),
    );

  const servers = Object.entries(config.mcp.servers)
    .map(([id, server]) => {
      const network = serverNetwork(server);
      const decision = egress.servers.find((s) => s.id === id);
      return {
        id,
        network,
        allowed: decision?.allowed ?? true,
        ...(decision?.exception ? { exception: decision.exception } : {}),
        ...(decision?.reason ? { reason: decision.reason } : {}),
      };
    })
    .filter((s) => s.network !== "none");
  for (const s of servers)
    checks.push(
      check(
        `egress:mcp:${s.id}`,
        !s.allowed || s.exception ? "warn" : "ok",
        s.id,
        s.exception
          ? `${s.network}, by an exception (reads only): ${s.exception}`
          : s.allowed
            ? s.network
            : (s.reason ?? `network ${s.network} is not allowed`),
      ),
    );

  const exceptions = egressNotices(config).map((n) => ({
    server: n.server,
    network: n.network,
    reason: n.reason,
  }));
  for (const e of exceptions)
    checks.push(
      check(
        `egress:exception:${e.server}`,
        "warn",
        e.server,
        `goes to the ${e.network} out of dataClass ${config.dataClass} (reads only): ${e.reason}`,
        "the exception lives in .jarvis/project.yaml egressExceptions (ADR-0016 §6)",
      ),
    );

  const exp = config.telemetry.export;
  const telemetryExport = {
    enabled: exp.enabled,
    network: exp.network,
    payloads: exp.payloads,
    maxPayloadBytes: exp.maxPayloadBytes,
    allowed: egress.telemetryExport.allowed,
    ...(egress.telemetryExport.reason ? { reason: egress.telemetryExport.reason } : {}),
  };
  checks.push(
    !telemetryExport.allowed
      ? check("telemetry", "fail", "telemetry export", telemetryExport.reason ?? "denied")
      : !exp.enabled
        ? check("telemetry", "ok", "telemetry export", "off")
        : exp.payloads
          ? check(
              "telemetry",
              "warn",
              "telemetry export",
              `${exp.network}, payloads on (redacted, ${exp.maxPayloadBytes} bytes per field)`,
              "payloads leave the machine: keep telemetry.export.payloads off unless security agreed (ADR-0010 §3)",
            )
          : check("telemetry", "ok", "telemetry export", `${exp.network}, metadata only (payloads off)`),
  );

  const secrets = collectSecretRefs(loaded).map((r) => ({
    path: r.path,
    ref: r.value,
    backend: parseSecretRef(r.value).kind,
  }));
  for (const s of secrets)
    checks.push(
      s.backend === "keychain"
        ? check(`secret:${s.path}`, "ok", s.path, s.ref)
        : check(
            `secret:${s.path}`,
            "warn",
            s.path,
            `${s.ref} — not a keychain: reference; the value sits in the environment of every process`,
            `run \`jarvis auth set ${parseSecretRef(s.ref).name}\` and use keychain:${parseSecretRef(s.ref).name}`,
          ),
    );
  if (secrets.length === 0) checks.push(check("secrets", "ok", "secrets", "no secret references in config"));

  const deniedPaths = { builtIn: DEFAULT_DENIED_PATHS.length, project: [...config.security.deniedPaths] };
  checks.push(
    check(
      "paths",
      "ok",
      "denied paths",
      `${deniedPaths.builtIn} built in (.env*, secrets/, *.pem, *.key, ~/.ssh, ~/.aws, .npmrc…)` +
        (deniedPaths.project.length > 0 ? ` + project: ${deniedPaths.project.join(", ")}` : ""),
      "a file agents report as not found may be denied here (ADR-0010 §2)",
    ),
  );
  const secretEnv = [...config.security.secretEnv];
  if (secretEnv.length > 0)
    checks.push(check("secretEnv", "ok", "secret env", `values of ${secretEnv.join(", ")} are masked`));

  const secretPatterns = config.security.secretPatterns.map((p) => ({
    name: p.name,
    ...tryPattern(p.regex),
  }));
  for (const p of secretPatterns)
    checks.push(
      p.ok
        ? check(`pattern:${p.name}`, "ok", p.name, "compiles, leaves ordinary text alone")
        : check(
            `pattern:${p.name}`,
            p.problem?.startsWith("also matches") ? "warn" : "fail",
            p.name,
            p.problem ?? "",
            "fix security.secretPatterns in .jarvis/project.yaml",
          ),
    );

  return {
    dataClass: config.dataClass,
    ...(redactions ? { redactions } : {}),
    models,
    servers,
    exceptions,
    telemetryExport,
    secrets,
    deniedPaths,
    secretEnv,
    secretPatterns,
    checks,
    ok: !checks.some((c) => c.status === "fail"),
  };
}

const SECTIONS: ReadonlyArray<{ title: string; of: (id: string) => boolean }> = [
  { title: "redactions", of: (id) => id.startsWith("redactions") },
  { title: "models by egress", of: (id) => id.startsWith("egress:model:") },
  { title: "MCP servers with network access", of: (id) => id.startsWith("egress:mcp:") },
  { title: "egress exceptions in force", of: (id) => id.startsWith("egress:exception:") },
  { title: "telemetry", of: (id) => id === "telemetry" },
  { title: "secrets", of: (id) => id === "secrets" || id.startsWith("secret:") },
  { title: "kept from agents", of: (id) => id === "paths" || id === "secretEnv" },
  { title: "project secret patterns", of: (id) => id.startsWith("pattern:") },
];

export function renderSecurityReport(ctx: CliContext, report: SecurityReport): void {
  const { out } = ctx;
  const st = out.style;
  const label: Record<CheckStatus, string> = {
    ok: st.ok("OK  "),
    warn: st.warn("WARN"),
    fail: st.bad("FAIL"),
  };
  out.line(st.heading("jarvis doctor --security"));
  out.line(`dataClass ${report.dataClass}`);
  for (const section of SECTIONS) {
    const checks = report.checks.filter((c) => section.of(c.id));
    if (checks.length === 0) continue;
    out.line();
    out.line(st.heading(section.title));
    const width = Math.max(...checks.map((c) => c.subject.length));
    for (const c of checks) {
      const detail = c.status === "ok" ? st.muted(c.detail) : c.detail;
      out.line(`  ${label[c.status]}  ${padEnd(c.subject, width)}  ${detail}`);
      if (c.hint) out.line(`        ${" ".repeat(width)}  ${st.muted("→")} ${st.cmd(c.hint)}`);
    }
  }
  if (!report.ok) throw new CliExit(EXIT.error);
}
