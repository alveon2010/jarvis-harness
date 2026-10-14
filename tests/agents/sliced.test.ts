import { describe, expect, it } from "vitest";
import { JavaExtractor } from "../../src/adapters/java/extractor.ts";
import { slicedFile } from "../../src/agents/context.ts";
import { currentSymbols } from "../../src/knowledge/graph/outline.ts";

const LONG = [
  "package a;",
  "public class OrderService {",
  "  public Order find(String id) {",
  "    return null;",
  "  }",
  ...Array.from({ length: 420 }, (_, i) => `  // filler ${i}`),
  "  void cancel(Order o) {",
  "    o.cancel();",
  "  }",
  "}",
].join("\n");

describe("a long file in a task message", () => {
  it("is its outline and the parts that matter, numbered as in the file", async () => {
    const symbols = await currentSymbols([new JavaExtractor()], "src/a/OrderService.java", LONG);
    const text = slicedFile("src/a/OrderService.java", LONG, symbols, ["cancel"], [[3, 4]]) ?? "";
    expect(text).toContain("src/a/OrderService.java: 429 lines — its outline");
    expect(text).toContain("  find(String): Order  [3-5]");
    expect(text).toContain(
      "#### lines 3-4\n    3    public Order find(String id) {\n    4      return null;",
    );
    expect(text).toContain("#### OrderService.cancel/1 (lines 426-428)\n  426    void cancel(Order o) {");
    expect(text).not.toContain("filler 10");
    // short: shown whole by the caller
    expect(slicedFile("src/a/S.java", "class S {}\n", symbols, [])).toBeUndefined();
  });
});
