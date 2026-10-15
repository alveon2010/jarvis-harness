import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../../src/ui/html.ts";
import { codeSpanHtml, fileRefOf, shortPath, shortSymbol } from "../../src/ui/refs.ts";

describe("code references on the pages", () => {
  it("shortens a long path by its parts and keeps the whole in the tooltip", () => {
    expect(shortPath("src/main/java/com/example/orders/util/SlotReader.java")).toEqual({
      dir: "src/main/java/…/util/",
      name: "SlotReader.java",
    });
    expect(shortPath("src/orders/api.ts")).toEqual({ dir: "src/orders/", name: "api.ts" });
    const ref = fileRefOf("src/main/java/com/example/orders/util/SlotReader.java:44-62") ?? "";
    expect(ref).toContain(
      'href="/open?path=src%2Fmain%2Fjava%2Fcom%2Fexample%2Forders%2Futil%2FSlotReader.java&amp;line=44"',
    );
    expect(ref).toContain(
      'title="src/main/java/com/example/orders/util/SlotReader.java:44-62 — open in the editor"',
    );
    expect(ref).toContain("<span>SlotReader.java");
  });

  it("splits a symbol into its type and member, folding the packages", () => {
    expect(shortSymbol("AbstractOrderService.correctDeliverySlots")).toEqual({
      qualifier: "AbstractOrderService.",
      member: "correctDeliverySlots",
    });
    expect(shortSymbol("com.example.orders.service.OrderService.placeOrder").qualifier).toBe(
      "…service.OrderService.",
    );
    const html = codeSpanHtml("AbstractOrderService.correctDeliverySlots");
    expect(html).toContain('class="sym" title="AbstractOrderService.correctDeliverySlots"');
    expect(html).toContain('<span class="cq">AbstractOrderService.</span><span>correctDeliverySlots</span>');
  });

  it("leaves names that are neither files nor symbols as code", () => {
    expect(codeSpanHtml("orders.created")).toBe("<code>orders.created</code>");
    expect(codeSpanHtml("a/b")).toBe("<code>a/b</code>");
    expect(codeSpanHtml("artifact:research/research.json@1")).not.toContain("href");
    expect(fileRefOf("ABC-42")).toBeUndefined();
  });

  it("links files in markdown: code spans and a bare File.java:12 in prose", () => {
    const out = markdownToHtml("See `src/orders/api.ts:12` and SlotService.java:30-41, not <b>.").value;
    expect(out).toContain('href="/open?path=src%2Forders%2Fapi.ts&amp;line=12"');
    expect(out).toContain('href="/open?path=SlotService.java&amp;line=30"');
    expect(out).toContain("&lt;b&gt;");
  });
});
