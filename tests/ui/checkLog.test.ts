import { describe, expect, it } from "vitest";
import { checkLogHtml } from "../../src/ui/checks.ts";

describe("a check's whole output on the page", () => {
  it("what broke marked and kept, the rest folded where it was, every line a click away", () => {
    const text = [
      ...Array.from({ length: 50 }, (_, i) => `> Task :compile${i}`),
      "e: OrderTotal.kt:41:5 Unresolved reference: percentOf",
      ...Array.from({ length: 30 }, (_, i) => `> Task :other${i}`),
      "BUILD FAILED in 4s",
    ].join("\n");
    const page = String(checkLogHtml(text));
    expect(page).toContain("82 lines · 2 say what broke, marked · the rest folded");
    expect(page).toContain("<mark>e: OrderTotal.kt:41:5 Unresolved reference: percentOf</mark>");
    expect(page).toContain("<summary>… 48 lines (1–48) — show</summary>");
    expect(page).toContain("&gt; Task :compile0\n");
    expect(page).toContain("data-unfold");
  });
});
