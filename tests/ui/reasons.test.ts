import { describe, expect, it } from "vitest";
import { inLang } from "../../src/ui/i18n.ts";
import { reasonText } from "../../src/ui/reasons.ts";

describe("a run's reason on the page", () => {
  it("says the engine's common reasons in Russian and leaves the rest as written", () => {
    expect(inLang("ru", () => reasonText("approve spec (spec.json@2)"))).toBe("одобрить spec (spec.json@2)");
    expect(inLang("ru", () => reasonText("waits for its subtasks: 1 of 3 done"))).toBe(
      "ждёт свои сабтаски: готово 1 из 3",
    );
    expect(
      inLang("ru", () =>
        reasonText("paused by me@example.com; Resume (or `jarvis continue`) goes on from here"),
      ),
    ).toBe("на паузе (me@example.com); «Продолжить» (или `jarvis continue`) пойдёт отсюда");
    expect(inLang("ru", () => reasonText("HTTP 502 from the gateway"))).toBe("HTTP 502 from the gateway");
    expect(inLang("en", () => reasonText("approve spec (spec.json@2)"))).toBe("approve spec (spec.json@2)");
  });
});
