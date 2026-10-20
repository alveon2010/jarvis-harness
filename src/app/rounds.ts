import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Rounds of implementation → checks, compared by Jarvis, not by a model (pilot: tests failed, the
 * implementation went back with the same reasons and failed the same way until no rounds were left —
 * and the person could only say «once more»). A failure is its check, its test and the first line of
 * its assertion; a round that fails exactly as the one before made no progress, so the run asks the
 * person instead of spending the next round. Tests that did not run at all (the build or the
 * environment broke) are the person's to look at from the first round.
 */

/** When a failed check stops the run for a person (`human.checks.ask`). */
export type AskWhen = "same-failure" | "every-failure" | "when-rounds-end";

export type StopWhy = "same-failure" | "not-started" | "every-failure";

export interface RoundFailure {
  readonly check: string;
  readonly suite?: string;
  readonly name?: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  /** Where it failed in the project: the frame the run changed, or the first one. */
  readonly at?: string;
  readonly signature: string;
}

export interface Round {
  readonly round: number;
  readonly failures: readonly RoundFailure[];
  /** The test checks of the round that did not get to run any test. */
  readonly notStarted: readonly string[];
  readonly checks: ArtifactVersion;
}

export interface RoundStop {
  readonly why: StopWhy;
  readonly round: number;
  /** Signatures failing in this round as in the one before. */
  readonly same: readonly string[];
}

interface CheckResult {
  readonly check?: unknown;
  readonly ok?: unknown;
  readonly skipped?: unknown;
  readonly tail?: unknown;
  readonly excerpt?: unknown;
  readonly notStarted?: unknown;
  readonly failures?: ReadonlyArray<{
    readonly suite?: string;
    readonly name?: string;
    readonly message?: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly preexisting?: boolean;
    readonly stack?: ReadonlyArray<{
      readonly file?: string;
      readonly line?: number;
      readonly changed?: boolean;
    }>;
  }>;
}

/** Digits and paths of temporary files vary from round to round; the failure does not. */
const steady = (s: string): string =>
  s
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/gi, "#")
    .replace(/(\/tmp|\/var\/folders)\/\S+/g, "<tmp>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

const ERROR_LINE = /(error|exception|fail|assert|expected|cannot|undefined|not found|✗|✘)/i;

/** The failures of one checks document, own ones only (the base commit's are not the run's). */
export function failuresOf(doc: unknown): { failures: RoundFailure[]; notStarted: string[] } {
  const results = (doc as { results?: unknown } | undefined)?.results;
  const failures: RoundFailure[] = [];
  const notStarted: string[] = [];
  if (!Array.isArray(results)) return { failures, notStarted };
  for (const r of results as CheckResult[]) {
    if (r.ok !== false || r.skipped || typeof r.check !== "string") continue;
    const check = r.check;
    if (r.notStarted === true) notStarted.push(check);
    const own = (r.failures ?? []).filter((f) => !f.preexisting);
    // every failing test fails on the base commit too: nothing of the run's
    if ((r.failures?.length ?? 0) > 0 && own.length === 0) continue;
    if (own.length > 0) {
      for (const f of own) {
        const message = (f.message ?? "").split("\n")[0] ?? "";
        const frame = f.stack?.find((s) => s.changed) ?? f.stack?.[0];
        failures.push({
          check,
          ...(f.suite ? { suite: f.suite } : {}),
          ...(f.name ? { name: f.name } : {}),
          message,
          ...(f.expected !== undefined ? { expected: f.expected } : {}),
          ...(f.actual !== undefined ? { actual: f.actual } : {}),
          ...(frame?.file ? { at: `${frame.file}${frame.line ? `:${frame.line}` : ""}` } : {}),
          signature: [check, f.suite ?? "", f.name ?? "", steady(message)].join("|"),
        });
      }
      continue;
    }
    // no report: the check's own lines that say what broke
    const tail = typeof r.excerpt === "string" ? r.excerpt : typeof r.tail === "string" ? r.tail : "";
    const lines = tail
      .split("\n")
      .filter((l) => ERROR_LINE.test(l))
      .slice(0, 3);
    const message = (lines[0] ?? tail.split("\n").filter(Boolean).at(-1) ?? "").trim();
    failures.push({ check, message, signature: [check, steady(lines.join(" "))].join("|") });
  }
  return { failures, notStarted };
}

const parse = (runtime: Runtime, a: ArtifactVersion): unknown => {
  try {
    return JSON.parse(runtime.artifacts.text(a));
  } catch {
    return undefined;
  }
};

/** The rounds of checks of a run, oldest first: one per round the checks ran in. */
export function roundsOf(runtime: Runtime, runId: string): Round[] {
  const latest = runtime.artifacts.find(runId, "checks", "checks.json");
  if (!latest) return [];
  const byRound = new Map<number, ArtifactVersion>();
  for (const v of runtime.artifacts.versions(latest.artifactId)) {
    if (v.iteration === undefined) continue;
    const had = byRound.get(v.iteration);
    if (!had || had.version < v.version) byRound.set(v.iteration, v);
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, checks]) => ({ round, checks, ...failuresOf(parse(runtime, checks)) }));
}

/**
 * Whether the round that just failed stops the run for a person, before the back edge is taken: the
 * checks of this very round failed and — by `ask` — the failures are the same as the round before, or
 * no test ran, or any failure at all. Nothing when the checks passed (another child sent it back).
 */
export function roundStop(
  runtime: Runtime,
  run: Pick<Run, "id">,
  round: number,
  ask: AskWhen,
): RoundStop | undefined {
  if (ask === "when-rounds-end") return undefined;
  const rounds = roundsOf(runtime, run.id);
  const now = rounds.find((r) => r.round === round);
  if (!now || (now.failures.length === 0 && now.notStarted.length === 0)) return undefined;
  if (ask === "every-failure") return { why: "every-failure", round, same: [] };
  if (now.notStarted.length > 0) return { why: "not-started", round, same: [] };
  const before = [...rounds].reverse().find((r) => r.round < round);
  if (!before || before.failures.length === 0) return undefined;
  const was = new Set(before.failures.map((f) => f.signature));
  const is = new Set(now.failures.map((f) => f.signature));
  const same = [...is].every((s) => was.has(s)) && [...was].every((s) => is.has(s));
  return same ? { why: "same-failure", round, same: [...is] } : undefined;
}
