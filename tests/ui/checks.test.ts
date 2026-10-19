import { describe, expect, it } from "vitest";
import { checksHtml, checksOf } from "../../src/ui/checks.ts";

/** The checks artifact as a person reads it: failed tests, expected and got, where, the whole output. */
const DOC = {
  changed: ["src/onboarding.ts"],
  results: [
    {
      check: "test",
      command: "npm test",
      ok: false,
      log: "art_abc@2",
      tests: { failed: 2, total: 14 },
      failures: [
        {
          suite: "onboarding › restart",
          name: "allows a restart after REJECTED",
          file: "src/onboarding.test.ts",
          message: "expect(received).toBe(expected)",
          expected: "true",
          actual: "false",
          stack: [
            { file: "src/onboarding.test.ts", line: 12 },
            { file: "src/onboarding.ts", line: 2, fn: "canRestart", changed: true },
          ],
          hidden: 3,
        },
      ],
    },
    { check: "typecheck", command: "tsc --noEmit", ok: true },
    { check: "lint", command: "eslint", ok: true, skipped: "no changed code in its scope" },
  ],
};

describe("checks page", () => {
  it("reads the document", () => {
    expect(checksOf(DOC)?.map((r) => r.check)).toEqual(["test", "typecheck", "lint"]);
    expect(checksOf({ summary: "x" })).toBeUndefined();
  });

  it("each failed test: expected and got, frames as editor links, the changed line, the whole output", () => {
    const out = String(checksHtml({ id: "run_e681da4d00000000" }, checksOf(DOC) ?? []));
    expect(out).toContain("2 tests failed. The implementation goes back with these failures as its reasons.");
    expect(out).toContain("✕ test · 2 of 14 failed");
    expect(out).toContain("✓ typecheck");
    expect(out).toContain("– lint · skipped");
    expect(out).toContain("<h3>allows a restart after REJECTED</h3>");
    expect(out).toContain('<code class="ok">true</code>');
    expect(out).toContain('<code class="bad">false</code>');
    expect(out).toContain('href="/open?path=src%2Fonboarding.ts&amp;line=2"');
    expect(out).toContain("changed by this run");
    expect(out).toContain("3 frames of the runner and libraries not shown");
    expect(out).toContain("1 more failed tests are in the full output.");
    expect(out).toContain('href="/runs/e681da4d/artifacts/check-log/test.log?v=2"');
  });
});
