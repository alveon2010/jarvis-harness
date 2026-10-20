import { describe, expect, it } from "vitest";
import { BudgetManager } from "../../src/budget/admission.ts";
import { MemoryUsageStore } from "../../src/budget/usage.ts";
import type { ProbeResult } from "../../src/models/probe.ts";
import { effectiveModel, resolveModel, validateRoles } from "../../src/models/router.ts";
import { testConfig } from "../helpers/modelConfig.ts";

const config = testConfig("http://127.0.0.1:1/v1");

describe("resolveModel", () => {
  it("takes the first candidate in preference order and reports its structured mode", () => {
    const r = resolveModel(config, "research");
    expect(r.modelId).toBe("private");
    expect(r.structuredMode).toBe("json");
    expect(r.pool).toBe("corp");
  });

  it("skips models that cannot meet the requirements", () => {
    const r = resolveModel(config, "research", { structuredOutput: "schema" });
    expect(r.modelId).toBe("schema");
    expect(r.structuredMode).toBe("schema");
    const big = resolveModel(config, "research", { minContext: 16_000 });
    expect(big.modelId).toBe("schema");
  });

  it("applies the egress rule — a cloud model is skipped in a confidential project", () => {
    expect(resolveModel(config, "review").modelId).toBe("private");
    const open = testConfig("http://127.0.0.1:1/v1", { dataClass: "public" });
    expect(resolveModel(open, "review").modelId).toBe("cloud");
  });

  it("explains every rejection when nothing fits", () => {
    expect(() => resolveModel(config, "strict", { reasoning: true })).toThrow(
      /private: does not support reasoning/,
    );
    expect(() => resolveModel(config, "nope")).toThrow(/role "nope" has no models/);
  });

  it("falls back to the next pool only when asked", () => {
    const usage = new MemoryUsageStore();
    usage.record({ pool: "corp", model: "private", promptTokens: 1, cachedTokens: 0, outputTokens: 999 });
    const budget = new BudgetManager(usage, config.quotaPools);
    expect(resolveModel(config, "research").modelId).toBe("private");
    expect(resolveModel(config, "research", {}, { fallbackPools: true, budget }).modelId).toBe("schema");
  });

  it("validates all roles a workflow needs up front", () => {
    const problems = validateRoles(config, [
      { role: "research", requires: { tools: true } },
      { role: "strict", requires: { structuredOutput: "schema" } },
      { role: "missing" },
    ]);
    expect(problems.map((p) => p.modelId)).toEqual(["strict", "missing"]);
  });

  it("trusts a fresh probe over the configuration: what it found missing is missing, and said so", () => {
    const probe = (
      supports: Partial<ProbeResult["supports"]>,
      at = new Date().toISOString(),
    ): ProbeResult => ({
      modelId: "private",
      probedAt: at,
      latencyMs: 10,
      supports: { tools: true, jsonMode: true, jsonSchema: false, systemRole: true, ...supports },
      errors: {},
      outputTokens: 1,
    });
    const probes = (p: ProbeResult) => ({ get: (id: string) => (id === "private" ? p : undefined) });
    // the probe found no tool calls: research needing tools goes to the next model
    const noTools = probes(probe({ tools: false }));
    expect(resolveModel(config, "research", { tools: true }, { probes: noTools }).modelId).toBe("schema");
    expect(() => resolveModel(config, "strict", { tools: true }, { probes: noTools })).toThrow(
      /does not support tool calling \(probe of \d{4}-\d\d-\d\d; the configuration claims tools/,
    );
    // no json mode: the structured mode the route reports goes down too
    expect(
      resolveModel(config, "strict", {}, { probes: probes(probe({ jsonMode: false })) }).structuredMode,
    ).toBe("text");
    // only down: a probe never adds what the configuration does not claim
    expect(effectiveModel(config.models.private as never, probe({ jsonSchema: true })).lacks).toEqual([]);
    // a stale probe or an undecided capability counts for nothing
    const old = probe({ tools: false }, "2020-01-01T00:00:00.000Z");
    expect(resolveModel(config, "strict", { tools: true }, { probes: probes(old) }).modelId).toBe("private");
    const undecided = { ...probe({ tools: false }), inconclusive: ["tools" as const] };
    expect(resolveModel(config, "strict", { tools: true }, { probes: probes(undecided) }).modelId).toBe(
      "private",
    );
  });
});
