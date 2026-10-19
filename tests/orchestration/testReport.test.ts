import { describe, expect, it } from "vitest";
import { expectedActualOf, javaFrames, parseJunitXml } from "../../src/orchestration/tools/testReport.ts";

/** Why tests failed, from the reports the runners write. */
const GRADLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OnboardingRestartTest" tests="3" skipped="0" failures="1" errors="1">
  <testcase name="restartAllowedOnceAfterRejected()" classname="com.example.OnboardingRestartTest" time="0.01">
    <failure message="org.opentest4j.AssertionFailedError: expected: &lt;true&gt; but was: &lt;false&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;true&gt; but was: &lt;false&gt;
	at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
	at com.example.OnboardingRestartTest.restartAllowedOnceAfterRejected(OnboardingRestartTest.java:42)
	at com.example.OnboardingService$Inner.canRestart(OnboardingService.java:118)
	... 31 more
</failure>
  </testcase>
  <testcase name="passes()" classname="com.example.OnboardingRestartTest" time="0.0"/>
  <testcase name="normalises()" classname="com.example.OnboardingRestartTest" time="0.0">
    <error message="address.street is null" type="java.lang.NullPointerException"><![CDATA[java.lang.NullPointerException: address.street is null
	at com.example.orders.AddressHandler.correct(AddressHandler.java:31)]]></error>
  </testcase>
</testsuite>`;

describe("JUnit XML", () => {
  it("each failed or erroring test: name, message, expected and actual, frames", () => {
    const r = parseJunitXml(GRADLE);
    expect(r.total).toBe(3);
    expect(r.failures).toHaveLength(2);
    const [a, b] = r.failures;
    expect(a).toMatchObject({
      suite: "com.example.OnboardingRestartTest",
      name: "restartAllowedOnceAfterRejected()",
      expected: "true",
      actual: "false",
    });
    expect(a?.message).toBe("org.opentest4j.AssertionFailedError: expected: <true> but was: <false>");
    expect(a?.stack.map((f) => [f.file, f.line])).toEqual([
      ["org.junit.jupiter.api.AssertionUtils", 55],
      ["com.example.OnboardingRestartTest", 42],
      ["com.example.OnboardingService", 118],
    ]);
    expect(b).toMatchObject({
      name: "normalises()",
      message: "java.lang.NullPointerException: address.street is null",
    });
    expect(b?.stack[0]).toMatchObject({ file: "com.example.orders.AddressHandler", fn: "correct", line: 31 });
  });

  it("expected and actual in the usual wordings", () => {
    expect(expectedActualOf("expected:<[1]> but was:<[2]>")).toEqual({ expected: "[1]", actual: "[2]" });
    expect(expectedActualOf('expected: "a"\n but was: "b"')).toEqual({ expected: '"a"', actual: '"b"' });
    expect(expectedActualOf("Expected: 3\nReceived: 4")).toEqual({ expected: "3", actual: "4" });
    expect(expectedActualOf("boom")).toEqual({});
  });

  it("Java frames, inner classes as their outer one", () => {
    expect(javaFrames("\tat a.B$C.m(B.java:7)\n\tat a.D.n(Native Method)")).toEqual([
      { file: "a.B", fn: "m", line: 7, raw: "at a.B$C.m(B.java:7)" },
      { file: "a.D", fn: "n", raw: "at a.D.n(Native Method)" },
    ]);
  });
});
