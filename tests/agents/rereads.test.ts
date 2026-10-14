import { describe, expect, it } from "vitest";
import { ReadLedger, readKey, UNCHANGED } from "../../src/agents/rereads.ts";
import { trimToolResults } from "../../src/context/index.ts";
import type { Message } from "../../src/models/types.ts";

const file =
  "[repo.read] ok\n    1  export function total(order) {\n    2    return order.items.length;\n    3  }";
const call = (id: string, path = "src/orders/total.ts", extra: Record<string, unknown> = {}): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "repo.read", arguments: JSON.stringify({ path, ...extra }) }],
});
const result = (id: string, content: string): Message => ({ role: "tool", toolCallId: id, content });

describe("a file read again in the same step (pilot: one file read 62 times)", () => {
  it("unchanged and still above: a pointer instead of the text; trimmed since: the text, pinned", () => {
    const ledger = new ReadLedger();
    const key = readKey("repo.read", { path: "./src/orders/total.ts" });
    expect(key).toBe("src/orders/total.ts#-");
    expect(readKey("repo.read", { path: "a.ts", startLine: 10, endLine: 20 })).toBe("a.ts#10-20");
    expect(readKey("repo.search", { pattern: "x" })).toBeUndefined();

    let transcript: Message[] = [call("c1")];
    const first = ledger.answer(key, "c1", file, transcript);
    expect(first).toEqual({ content: file, kind: "first" });
    transcript = [...transcript, result("c1", first.content), call("c2")];

    const again = ledger.answer(key, "c2", file, transcript);
    expect(again.kind).toBe("unchanged");
    expect(again.content).toContain(UNCHANGED);
    expect(again.content).toContain("call c1");
    expect(again.content.length).toBeLessThan(file.length + 200);
    transcript = [...transcript, result("c2", again.content)];

    // the first read trimmed away: the text comes back and is kept from now on
    const trim = trimToolResults(transcript, {
      keepRecent: 0,
      minChars: 10,
      store: () => "ref",
    });
    const trimmed = trim.transcript;
    // each trimmed result says which call it answered: the page names a re-read of it so
    expect(trim.originals[0]?.call).toMatch(/^repo\.read /);
    // a trimmed file is read again with repo.read (then kept), not fetched back by its blob
    expect(JSON.stringify(trimmed)).toContain("run the tool again if you need it");
    expect(JSON.stringify(trimmed)).not.toContain("knowledge.read");
    const back = ledger.answer(key, "c3", file, [...trimmed, call("c3")]);
    expect(back.kind).toBe("again");
    expect(back.content.startsWith(file)).toBe(true);
    expect(ledger.pinned("c3")).toBe(true);
    const later = [
      ...trimmed,
      call("c3"),
      result("c3", back.content),
      call("c4"),
      result("c4", `[repo.read] ok\n${"x".repeat(900)}`),
    ];
    // light pressure keeps the pinned result, as the manager asks
    const light = trimToolResults(later, {
      keepRecent: 0,
      minChars: 10,
      store: () => "ref",
      keep: (_c, m) => ledger.pinned(m.toolCallId ?? ""),
    }).transcript;
    expect(light.find((m) => m.toolCallId === "c3")?.content).toBe(back.content);

    // changed on disk since: the new text, marked
    const edited = file.replace("length", "count");
    const changed = ledger.answer(key, "c5", edited, [...later, call("c5")]);
    expect(changed.kind).toBe("changed");
    expect(changed.content).toContain("(changed since your read in call c3)");
  });

  it("a resumed step knows what it read before it parked", () => {
    const transcript: Message[] = [
      call("c1"),
      result("c1", file),
      call("c2", "src/orders/other.ts"),
      result("c2", "[repo.read] error: no such file"),
    ];
    const ledger = ReadLedger.from(transcript);
    expect(
      ledger.answer(readKey("repo.read", { path: "src/orders/total.ts" }), "c3", file, transcript).kind,
    ).toBe("unchanged");
    // a failed read is not a read
    expect(
      ledger.answer(readKey("repo.read", { path: "src/orders/other.ts" }), "c4", file, transcript).kind,
    ).toBe("first");
    // a different range is a different read
    expect(
      ledger.answer(
        readKey("repo.read", { path: "src/orders/total.ts", startLine: 1, endLine: 2 }),
        "c5",
        file,
        transcript,
      ).kind,
    ).toBe("first");
  });
});

describe("a file the task message already shows whole", () => {
  it("unchanged: a pointer to the task message; asked again, the text; changed: the text", async () => {
    const { contentHash } = await import("../../src/agents/rereads.ts");
    const body = file.replace(/^\[repo\.read\] ok\n/, "");
    const ledger = new ReadLedger();
    ledger.seed(new Map([["src/orders/total.ts", contentHash(body)]]));
    const key = readKey("repo.read", { path: "src/orders/total.ts" });
    let transcript: Message[] = [call("c1")];
    const first = ledger.answer(key, "c1", file, transcript);
    expect(first.kind).toBe("in-task");
    expect(first.content).toContain("is in your task message");
    transcript = [...transcript, result("c1", first.content), call("c2")];
    const second = ledger.answer(key, "c2", file, transcript);
    expect(second.kind).toBe("again");
    expect(second.content).toContain("export function total");
    // changed since the task message was built: the text, as a first read
    const other = new ReadLedger();
    other.seed(new Map([["src/orders/total.ts", contentHash("something else")]]));
    expect(other.answer(key, "c3", file, [call("c3")]).kind).toBe("first");
    // a range is not the whole file
    const ranged = readKey("repo.read", { path: "src/orders/total.ts", startLine: 1, endLine: 2 });
    expect(ledger.answer(ranged, "c4", file, [call("c4")]).kind).toBe("first");
  });
});

describe("reads of a long file: its outline, a symbol, all of it", () => {
  it("are reads of their own; the outline of a file the task message shows is a pointer", () => {
    expect(readKey("repo.read", { path: "a/S.java" })).toBe("a/S.java#-");
    expect(readKey("repo.read", { path: "a/S.java", full: true })).toBe("a/S.java#-!");
    expect(readKey("repo.read", { path: "a/S.java", symbol: "S.find" })).toBe("a/S.java@S.find");
    expect(readKey("repo.read", { path: "a/S.java", symbol: "S.find", startLine: 3 })).toBe("a/S.java#3-");
    const ledger = new ReadLedger();
    ledger.seed(new Map([["a/S.java", "hash-of-the-whole-file"]]));
    const outline =
      "[repo.read] ok\na/S.java: 900 lines — its outline (read whole only if you need all of it):";
    expect(ledger.answer("a/S.java#-", "c1", outline, [], "hash-of-the-whole-file").kind).toBe("in-task");
    expect(new ReadLedger().answer("a/S.java#-", "c1", outline, [], "hash-of-the-whole-file").kind).toBe(
      "first",
    );
  });
});
