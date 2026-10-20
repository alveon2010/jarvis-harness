import { describe, expect, it } from "vitest";
import { diagnosticsIn, parseDiagnostics } from "../../src/orchestration/tools/diagnostics.ts";

describe("diagnostics from what typecheck and lint print", () => {
  it("reads the common forms: tsc, tsc --pretty, kotlinc, javac, gcc-like, eslint stylish", () => {
    const of = (text: string) =>
      parseDiagnostics(text, "x").map(
        (d) => `${d.range?.file}:${d.range?.startLine} ${d.severity} ${d.code ?? "-"} ${d.message}`,
      );
    expect(of("src/a.ts(12,5): error TS2322: Type 'x' is wrong.")).toEqual([
      "src/a.ts:12 error TS2322 Type 'x' is wrong.",
    ]);
    expect(of("src/a.ts:12:5 - error TS2304: Cannot find name 'y'.")).toEqual([
      "src/a.ts:12 error TS2304 Cannot find name 'y'.",
    ]);
    expect(of("e: file:///w/src/main/kotlin/OrderTotal.kt:41:9 Unresolved reference: round")).toEqual([
      "/w/src/main/kotlin/OrderTotal.kt:41 error - Unresolved reference: round",
    ]);
    expect(of("src/main/java/Order.java:12: error: cannot find symbol")).toEqual([
      "src/main/java/Order.java:12 error - cannot find symbol",
    ]);
    expect(of("pkg/a.go:3:2: undefined: foo")).toEqual(["pkg/a.go:3 error - undefined: foo"]);
    expect(of("\x1b[1msrc/b.ts\x1b[0m\n  3:1  warning  Unexpected console  no-console\n")).toEqual([
      "src/b.ts:3 warning no-console Unexpected console",
    ]);
    expect(of("Found 2 errors. Watching for file changes.")).toEqual([]);
  });

  it("keeps the files asked, named by their end too", () => {
    const all = parseDiagnostics("src/a/x.ts(1,1): error TS1: a\nsrc/b/y.ts(1,1): error TS1: b", "tsc");
    expect(diagnosticsIn(all, ["x.ts"]).map((d) => d.message)).toEqual(["a"]);
    expect(diagnosticsIn(all, [])).toHaveLength(2);
  });
});
