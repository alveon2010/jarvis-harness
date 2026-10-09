import { describe, expect, it } from "vitest";
import {
  ContextManager,
  DEFAULT_THRESHOLDS,
  TRIMMED_MARKER,
  trimToolResults,
} from "../../src/context/index.ts";
import type { Message } from "../../src/models/types.ts";

/** A tool call and its result of `size` characters. */
const result = (id: string, name: string, size: number): Message[] => [
  { role: "assistant", content: "", toolCalls: [{ id, name, arguments: "{}" }] },
  { role: "tool", toolCallId: id, content: `[${name}] ok\n${"x".repeat(size)}` },
];
const trimmedIds = (transcript: readonly Message[]) =>
  transcript.filter((m) => m.role === "tool" && m.content.includes(TRIMMED_MARKER)).map((m) => m.toolCallId);
const cheap = (m: Message, names: Map<string, string>) => /search$/.test(names.get(m.toolCallId ?? "") ?? "");

describe("trimming at the watch level: only down to a target, searches first", () => {
  // pilot: at 184k of a 459k window every old result went (66, 305k chars) and 19 files were read again
  const transcript = [
    ...result("r1", "repo.read", 3000),
    ...result("s1", "repo.search", 1500),
    ...result("r2", "repo.read", 3000),
    ...result("s2", "repo.search", 1500),
    ...result("r3", "repo.read", 3000),
    ...result("r4", "repo.read", 3000),
    ...result("n1", "repo.read", 1000),
    ...result("n2", "repo.read", 1000),
    ...result("n3", "repo.read", 1000),
  ];
  const names = new Map(transcript.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name] as const)));

  it("trimToolResults with saveChars: the searches, then the oldest reads, until enough is saved", () => {
    const r = trimToolResults(transcript, {
      keepRecent: 3,
      store: () => "ref",
      saveChars: 6000,
      first: (m) => cheap(m, names),
    });
    expect(trimmedIds(r.transcript)).toEqual(["r1", "s1", "r2", "s2"]);
    // without a target: every old result, as before
    expect(trimmedIds(trimToolResults(transcript, { keepRecent: 3, store: () => "ref" }).transcript)).toEqual(
      ["r1", "s1", "r2", "s2", "r3", "r4"],
    );
  });

  it("the manager at watch sheds what puts the prompt back under 75% of the watch level, no more", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const estimate = (ms: readonly Message[]) => Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / 4);
    const manager = new ContextManager({
      effective: 10_000,
      thresholds: DEFAULT_THRESHOLDS,
      compactTarget: 0.35,
      estimate,
      store: () => "ref",
      summarize: async () => "unused",
      emit: (kind, payload) => events.push({ kind, payload }),
    });
    const before = estimate(transcript);
    expect(before / 10_000).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.watch);
    const r = await manager.manage([], transcript);
    expect(r.level).toBe("watch");
    expect(trimmedIds(r.transcript)).toEqual(["r1", "s1", "r2", "s2"]); // r3 and r4 stay
    const after = estimate(r.transcript);
    expect(after).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.watch * 0.75 * 10_000);
    expect(after).toBeGreaterThan(DEFAULT_THRESHOLDS.watch * 0.5 * 10_000);
    expect(events.map((e) => e.kind)).toEqual(["context.pressure", "context.trimmed"]);
  });
});

describe("the working set: tool results past it go to pointers whatever the window", () => {
  // pilot: 500k window, nothing trimmed before 178k tokens; every call sent the whole history again
  it("over the working set the oldest go, down to 60% of it, the newest three and sources stay", async () => {
    const events: string[] = [];
    const estimate = (ms: readonly Message[]) => Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / 4);
    const transcript = [
      ...result("j1", "jira.get", 3000),
      ...result("a1", "repo.read", 4000),
      ...result("a2", "repo.read", 4000),
      ...result("a3", "repo.read", 4000),
      ...result("a4", "repo.read", 1000),
      ...result("a5", "repo.read", 1000),
      ...result("a6", "repo.read", 1000),
    ];
    const manager = new ContextManager({
      effective: 1_000_000,
      thresholds: DEFAULT_THRESHOLDS,
      compactTarget: 0.35,
      workingSet: 3_000,
      estimate,
      store: () => "ref",
      summarize: async () => "unused",
      emit: (kind) => events.push(kind),
    });
    const r = await manager.manage([], transcript);
    expect(r.level).toBe("healthy");
    expect(r.changed).toBe(true);
    // 4.5k tokens over a 3k set: shed to 1.8k — the three big reads go, the issue (a source) stays
    expect(trimmedIds(r.transcript)).toEqual(["a1", "a2", "a3"]);
    expect(estimate(r.transcript)).toBeLessThanOrEqual(3_000 * 0.6 + 1_200);
    expect(events).toEqual(["context.trimmed"]);
    // under the set: nothing happens
    const again = await manager.manage([], r.transcript);
    expect(again.changed).toBe(false);
    // off
    const off = new ContextManager({
      effective: 1_000_000,
      thresholds: DEFAULT_THRESHOLDS,
      compactTarget: 0.35,
      workingSet: 0,
      estimate,
      store: () => "ref",
      summarize: async () => "unused",
      emit: () => undefined,
    });
    expect((await off.manage([], transcript)).changed).toBe(false);
  });
});
