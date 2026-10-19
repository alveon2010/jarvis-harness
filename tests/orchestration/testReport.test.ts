import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  jsExpectedActual,
  jsRunnerOf,
  parseJestJson,
  parseJsText,
  parseMochaJson,
} from "../../src/adapters/typescript/testReport.ts";
import {
  changedLinesOf,
  expectedActualOf,
  failureReasons,
  javaFrames,
  parseJunitXml,
  placeFailure,
} from "../../src/orchestration/tools/testReport.ts";

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

describe("JavaScript runners", () => {
  const ws = "/w/app";

  it("the runner: named in the command, or behind a package script", () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", "test:e2e": "mocha e2e" } }),
    );
    expect(jsRunnerOf("npx jest --ci", dir)).toEqual({ runner: "jest", dashDash: false });
    expect(jsRunnerOf("yarn test", dir)).toEqual({ runner: "vitest", dashDash: false });
    expect(jsRunnerOf("npm run test:e2e", dir)).toEqual({ runner: "mocha", dashDash: true });
    expect(jsRunnerOf("make test", dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a jest report: titles, file, expected and received, frames in the project only", () => {
    const report = parseJestJson(
      {
        numTotalTests: 5,
        testResults: [
          {
            name: "/w/app/src/onboarding.test.ts",
            status: "failed",
            assertionResults: [
              { status: "passed", title: "works", ancestorTitles: ["onboarding"] },
              {
                status: "failed",
                title: "allows a restart after REJECTED",
                ancestorTitles: ["onboarding", "restart"],
                failureMessages: [
                  "Error: \u001b[2mexpect(\u001b[22mreceived\u001b[2m).\u001b[22mtoBe(expected)\n\nExpected: true\nReceived: false\n    at Object.<anonymous> (/w/app/src/onboarding.test.ts:12:31)\n    at Promise.then.completed (/w/app/node_modules/jest-circus/build/utils.js:298:28)\n    at canRestart (/w/app/src/onboarding.ts:2:10)",
                ],
              },
            ],
          },
          {
            name: "/w/app/src/broken.test.ts",
            status: "failed",
            message: "SyntaxError: Unexpected token (3:4)",
            assertionResults: [],
          },
        ],
      },
      ws,
    );
    expect(report.total).toBe(5);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toMatchObject({
      suite: "onboarding › restart",
      name: "allows a restart after REJECTED",
      file: "src/onboarding.test.ts",
      expected: "true",
      actual: "false",
    });
    expect(report.failures[0]?.stack.map((f) => `${f.file}:${f.line}`)).toEqual([
      "src/onboarding.test.ts:12",
      "src/onboarding.ts:2",
    ]);
    expect(report.failures[1]).toMatchObject({
      name: "the test file failed to run",
      file: "src/broken.test.ts",
    });
  });

  it("vitest's chai wording", () => {
    expect(jsExpectedActual("AssertionError: expected false to be true // Object.is equality")).toEqual({
      expected: "true",
      actual: "false",
    });
  });

  it("a mocha report", () => {
    const r = parseMochaJson(
      {
        stats: { tests: 3 },
        failures: [
          {
            title: "returns the slot",
            fullTitle: "slots returns the slot",
            file: "/w/app/test/slots.spec.js",
            err: {
              message: "expected 1 to equal 2",
              stack:
                "AssertionError: expected 1 to equal 2\n    at Context.<anonymous> (test/slots.spec.js:9:20)",
              expected: 2,
              actual: 1,
            },
          },
        ],
      },
      ws,
    );
    expect(r.failures[0]).toMatchObject({
      suite: "slots",
      name: "returns the slot",
      file: "test/slots.spec.js",
      expected: "2",
      actual: "1",
    });
    expect(r.failures[0]?.stack[0]).toMatchObject({ file: "test/slots.spec.js", line: 9 });
  });

  it("the printed output when no report came: jest and vitest", () => {
    const jest = parseJsText(
      "FAIL src/a.test.ts\n  ● a › adds\n\n    expect(received).toBe(expected)\n\n    Expected: 3\n    Received: 4\n\n      at Object.<anonymous> (src/a.test.ts:4:15)\n\nTest Suites: 1 failed, 1 total",
      ws,
    );
    expect(jest?.failures[0]).toMatchObject({ suite: "a", name: "adds", expected: "3", actual: "4" });
    expect(jest?.failures[0]?.stack[0]).toMatchObject({ file: "src/a.test.ts", line: 4 });
    const vitest = parseJsText(
      " FAIL  src/b.test.ts > b > subtracts\nAssertionError: expected 1 to be 2 // Object.is equality\n ❯ src/b.test.ts:7:14\n\n⎯⎯⎯⎯⎯⎯",
      ws,
    );
    expect(vitest?.failures[0]).toMatchObject({
      suite: "b",
      name: "subtracts",
      file: "src/b.test.ts",
      expected: "2",
      actual: "1",
    });
    expect(vitest?.failures[0]?.stack[0]).toMatchObject({ file: "src/b.test.ts", line: 7 });
  });
});

describe("failures in the project", () => {
  const files = [
    "src/main/java/com/example/OnboardingService.java",
    "src/test/java/com/example/OnboardingRestartTest.java",
  ];
  const diff = [
    "diff --git a/src/main/java/com/example/OnboardingService.java b/src/main/java/com/example/OnboardingService.java",
    "--- a/src/main/java/com/example/OnboardingService.java",
    "+++ b/src/main/java/com/example/OnboardingService.java",
    "@@ -116,2 +116,4 @@ class OnboardingService {",
    "+  a",
    "@@ -200 +202,0 @@",
  ].join("\n");

  it("the lines the run changed, from the diff", () => {
    expect([...changedLinesOf(diff)]).toEqual([
      ["src/main/java/com/example/OnboardingService.java", [[116, 119]]],
    ]);
  });

  it("frames in the project's files, the changed line marked; the reasons name it first", () => {
    const [f] = parseJunitXml(GRADLE).failures;
    const placed = placeFailure(f as never, files, changedLinesOf(diff));
    expect(placed.stack.map((s) => [s.file, s.line, s.changed ?? false])).toEqual([
      ["src/test/java/com/example/OnboardingRestartTest.java", 42, false],
      ["src/main/java/com/example/OnboardingService.java", 118, true],
    ]);
    expect(placed.hidden).toBe(1);
    const [reason] = failureReasons("test", [placed]);
    expect(reason?.summary).toBe(
      'test: test "com.example.OnboardingRestartTest › restartAllowedOnceAfterRejected()" failed: org.opentest4j.AssertionFailedError: expected: <true> but was: <false>; expected true, got false — at src/main/java/com/example/OnboardingService.java:118 (changed by this run)',
    );
    expect(reason?.sourceRefs).toEqual([
      "check:test",
      "src/test/java/com/example/OnboardingRestartTest.java:42",
      "src/main/java/com/example/OnboardingService.java:118",
    ]);
  });

  it("pre-existing failures give no reason; past five, one line for the rest", () => {
    const base = { name: "t", message: "m", stack: [], hidden: 0 };
    expect(failureReasons("test", [{ ...base, preexisting: true }])).toEqual([]);
    const many = Array.from({ length: 7 }, (_, i) => ({ ...base, name: `t${i}` }));
    const reasons = failureReasons("test", many);
    expect(reasons).toHaveLength(6);
    expect(reasons[5]?.summary).toBe("test: 2 more failed: t5, t6");
  });
});
