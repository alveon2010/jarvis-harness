import { describe, expect, it } from "vitest";
import { redactedSpans } from "../../src/agents/contextOps.ts";
import { tryPattern } from "../../src/cli/commands/doctorSecurity.ts";
import {
  formatRedactionStats,
  highEntropyBurst,
  recordRedaction,
  summarizeRedactions,
} from "../../src/security/redactionStats.ts";
import { Redactor } from "../../src/security/redactor.ts";
import { MemoryEventStore, type StoredEvent } from "../../src/telemetry/events.ts";

const SECRET = "orders-api-token-9f8e7d6c5b4a";

describe("redaction events (ADR-0010 §4)", () => {
  it("records the boundary, the types and the count, never the value or its start", () => {
    const redactor = new Redactor({ literals: [SECRET] });
    const events = new MemoryEventStore();
    const report = redactor.redact(`token=${SECRET} and Bearer abcdefghijklmnop1234567890`);
    recordRedaction(events, report, { boundary: "model-request", runId: "run_1", stepId: "research" });
    expect(events.events).toHaveLength(1);
    const e = events.events[0];
    expect(e?.kind).toBe("security.redaction");
    expect(e?.payload).toEqual({
      boundary: "model-request",
      count: 2,
      byType: { literal: 1, bearer: 1 },
    });
    const stored = JSON.stringify(e);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SECRET.slice(0, 6));
    expect(stored).not.toContain("abcdefgh");
  });

  it("leaves no event for a pass that masked nothing", () => {
    const events = new MemoryEventStore();
    recordRedaction(events, new Redactor().redact("plain text"), { boundary: "artifact", runId: "run_1" });
    expect(events.events).toHaveLength(0);
  });

  it("sums a period by boundary and type; events before the boundary was named count as tool output", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
    const ev = (seq: number, hoursAgo: number, payload: Record<string, unknown>, runId = "run_a") =>
      ({ seq, ts: at(hoursAgo), kind: "security.redaction", runId, payload }) as StoredEvent;
    const events = [
      ev(1, 1, { boundary: "tool", count: 3, byType: { assignment: 2, bearer: 1 } }),
      ev(2, 2, { boundary: "artifact", count: 1, byType: { literal: 1 } }, "run_b"),
      ev(3, 30, { count: 2, byType: { "high-entropy": 2 } }),
      ev(4, 200, { boundary: "tool", count: 9, byType: { pem: 9 } }),
    ];
    const day = summarizeRedactions(events, new Date(now.getTime() - 24 * 3_600_000));
    expect(day).toMatchObject({
      total: 4,
      events: 2,
      runs: 2,
      byBoundary: { tool: 3, artifact: 1 },
      byType: { assignment: 2, bearer: 1, literal: 1 },
    });
    const week = summarizeRedactions(events, new Date(now.getTime() - 7 * 24 * 3_600_000));
    expect(week.total).toBe(6);
    expect(week.byBoundary).toEqual({ tool: 5, artifact: 1 });
    expect(formatRedactionStats(week)).toBe(
      "6 in 2 runs (tool 5, artifact 1; assignment ×2, high-entropy ×2, bearer ×1, literal ×1)",
    );
    expect(formatRedactionStats(summarizeRedactions([], now))).toBe("none");
    expect(highEntropyBurst(week)).toBe(false);
    expect(highEntropyBurst({ ...week, byType: { "high-entropy": 25 } })).toBe(true);
  });
});

describe("project secret patterns tried by doctor --security", () => {
  it("accepts a precise pattern and names what is wrong with the others", () => {
    expect(tryPattern("\\bshp_[A-Za-z0-9]{24}\\b")).toEqual({ ok: true });
    expect(tryPattern("(unclosed")).toMatchObject({ ok: false });
    expect(tryPattern("(unclosed").problem).toContain("does not compile");
    expect(tryPattern("x*").problem).toBe("matches an empty string");
    expect(tryPattern("[a-z]+-api").problem).toContain('also matches ordinary text: "orders-api"');
  });
});

describe("redacted places in the context preview", () => {
  it("lists each placeholder with its message, tool and the text around it", () => {
    const redactor = new Redactor({ literals: [SECRET] });
    const masked = redactor.redact(`config:\n  apiUrl: https://orders.local\n  token: ${SECRET}\n`).text;
    const spans = redactedSpans([
      { role: "system", content: "You are the research agent." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "repo.read", arguments: '{"path":"config.yaml"}' }],
      },
      { role: "tool", toolCallId: "c1", content: masked },
    ]);
    expect(spans.total).toBe(1);
    expect(spans.byType).toEqual({ literal: 1 });
    const span = spans.spans[0];
    expect(span).toMatchObject({ message: 3, role: "tool", tool: "repo.read", type: "literal" });
    expect(span?.placeholder).toMatch(/^\[REDACTED:literal:[0-9a-f]{8}\]$/);
    expect(span?.excerpt).toContain(`token: ${span?.placeholder}`);
    expect(span?.excerpt).not.toContain("\n");
    expect(JSON.stringify(spans)).not.toContain(SECRET);
  });

  it("is empty for a transcript with nothing masked", () => {
    expect(redactedSpans([{ role: "user", content: "ABC-42" }])).toEqual({ total: 0, byType: {}, spans: [] });
  });
});
