import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../src/core/config/schema.ts";
import { buildChatBody, effortFor } from "../../src/models/providers/openaiCompatible.ts";
import { testConfig } from "../helpers/modelConfig.ts";

/** reasoning_effort: the agent's over the model's, and only to a model that reasons. */
const base = testConfig("http://x").models.private as ModelConfig;
const ask = { modelId: "private", messages: [{ role: "user" as const, content: "17*23?" }] };

describe("reasoning effort", () => {
  it("the model's own goes with every call; the agent's wins where the model reasons", () => {
    const own: ModelConfig = { ...base, reasoningEffort: "low" };
    expect(buildChatBody(ask, own).reasoning_effort).toBe("low");
    expect(buildChatBody({ ...ask, reasoningEffort: "high" }, own).reasoning_effort).toBe("high");
    const reasons: ModelConfig = { ...base, supports: { ...base.supports, reasoning: true } };
    expect(buildChatBody({ ...ask, reasoningEffort: "none" }, reasons).reasoning_effort).toBe("none");
    expect(effortFor(ask, reasons)).toBeUndefined();
  });

  it("a model that does not reason gets no field it may refuse", () => {
    expect(base.supports.reasoning).toBe(false);
    expect("reasoning_effort" in buildChatBody({ ...ask, reasoningEffort: "low" }, base)).toBe(false);
    expect("reasoning_effort" in buildChatBody(ask, base)).toBe(false);
  });
});
