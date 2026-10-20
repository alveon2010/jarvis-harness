import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Runtime } from "../app/runtime.ts";
import { EVERY, type EvalSchedule } from "../core/config/schema.ts";
import { diffResults, runSuite, type SuiteResult } from "./runner.ts";

/**
 * Scheduled live evals (ADR-0012 §5): the daemon runs a suite when it is due (`evals.schedule`), with
 * only the models of the schedule's quota pool (so it never eats the team's interactive quota), writes
 * `evals/results/<date>-<suite>.json`, compares it with `evals/baseline/<suite>.json` and records the
 * outcome as an event; a regression is a notice on the Runs page. The schedule's state is the journal:
 * the last `evals.scheduled.started` / `evals.scheduled` of the suite.
 */
export const STARTED_EVENT = "evals.scheduled.started";
export const FINISHED_EVENT = "evals.scheduled";

/** A run of a suite that started this long ago and never finished is taken as dead (the daemon was killed). */
const STALE_MS = 6 * 3600_000;

export function schedulesOf(runtime: Runtime): EvalSchedule[] {
  const s = runtime.loaded.config.evals.schedule;
  return Array.isArray(s) ? s : s ? [s] : [];
}

/** `24h` → ms. */
export function everyMs(every: string): number {
  const m = EVERY.exec(every);
  if (!m) throw new Error(`not a period: ${every}`);
  const unit = { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

/** One cron field → the values it allows: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, lists of them. */
function cronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron: cannot read "${part}"`);
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) throw new Error(`cron: "${part}" is out of range`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

interface Cron {
  readonly minute: Set<number>;
  readonly hour: Set<number>;
  readonly day: Set<number>;
  readonly month: Set<number>;
  readonly weekday: Set<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron: five fields expected, got "${expr}"`);
  const [minute, hour, day, month, weekday] = f as [string, string, string, string, string];
  const wd = cronField(weekday, 0, 7);
  if (wd.has(7)) wd.add(0);
  return {
    minute: cronField(minute, 0, 59),
    hour: cronField(hour, 0, 23),
    day: cronField(day, 1, 31),
    month: cronField(month, 1, 12),
    weekday: wd,
    anyDay: day === "*",
    anyWeekday: weekday === "*",
  };
}

function cronMatches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1))
    return false;
  const day = c.day.has(d.getDate());
  const weekday = c.weekday.has(d.getDay());
  // as cron: with both restricted, either one is enough
  return c.anyDay || c.anyWeekday ? day && weekday : day || weekday;
}

/** The first minute after `after` the expression names (local time), within a year and a day. */
export function nextCron(expr: string, after: Date): Date | undefined {
  const c = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60 + 1; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(c, d)) return new Date(d.getTime());
  }
  return undefined;
}

export interface ScheduledEvalOutcome {
  readonly suite: string;
  readonly at: string;
  readonly mode: string;
  readonly pool: string;
  readonly file?: string;
  readonly summary?: SuiteResult["summary"];
  /** The baseline it was compared with (its `at`); none — no baseline yet. */
  readonly baseline?: string;
  readonly regressed: boolean;
  readonly regressions: readonly string[];
  readonly error?: string;
}

export interface ScheduleState {
  readonly schedule: EvalSchedule;
  readonly last?: ScheduledEvalOutcome;
  /** A run of the suite started and has not finished (not stale). */
  readonly running?: string;
  /** When it is due next; now or earlier — due. Undefined for a cron that names no minute within a year. */
  readonly next?: Date;
}

/** The suite's latest event of a kind: its order in the journal and its payload (whose `at` is its time). */
function latestOf(
  runtime: Runtime,
  kind: string,
  suite: string,
): { seq: number; at: string; payload: Record<string, unknown> } | undefined {
  const events = runtime.events.list({ kind, limit: 1_000_000 });
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const p = e?.payload as { suite?: unknown; at?: unknown } | undefined;
    if (e && p?.suite === suite)
      return { seq: e.seq, at: typeof p.at === "string" ? p.at : e.ts, payload: e.payload ?? {} };
  }
  return undefined;
}

/**
 * Where a schedule stands: its last outcome, whether it runs now, and when it is due. `every`: a period
 * after the last start, or now when it never ran; `cron`: the first named minute after the last start,
 * or — never ran — the minute now is in, if the expression names it.
 */
export function scheduleState(runtime: Runtime, schedule: EvalSchedule, now: Date): ScheduleState {
  const started = latestOf(runtime, STARTED_EVENT, schedule.suite);
  const finished = latestOf(runtime, FINISHED_EVENT, schedule.suite);
  const last = finished ? (finished.payload as unknown as ScheduledEvalOutcome) : undefined;
  const open = started && (!finished || finished.seq < started.seq) ? started.at : undefined;
  const running = open && now.getTime() - Date.parse(open) < STALE_MS ? open : undefined;
  const from = started ? new Date(started.at) : undefined;
  const next = schedule.every
    ? from
      ? new Date(from.getTime() + everyMs(schedule.every))
      : now
    : nextCron(schedule.cron as string, from ?? new Date(now.getTime() - 60_000));
  return {
    schedule,
    ...(last ? { last } : {}),
    ...(running ? { running } : {}),
    ...(next ? { next } : {}),
  };
}

export interface ScheduledEvalsOptions {
  /** Where `evals/results` and `evals/baseline` are (as `jarvis evals run|diff` from there). */
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Runs the suite; the runner by default (tests put a fake here). */
  readonly run?: typeof runSuite;
}

/** The suite's directory: a path, or a name under the knowledge repository's or the project's `evals/`. */
function suiteDirOf(runtime: Runtime, cwd: string, suite: string): string {
  if (suite.includes("/")) return resolve(cwd, suite);
  return join(runtime.loaded.meta?.root ?? cwd, "evals", suite);
}

/** Runs one schedule now: the suite on its pool, the result file, the diff against the baseline, the event. */
export async function runScheduledEval(
  runtime: Runtime,
  schedule: EvalSchedule,
  options: ScheduledEvalsOptions,
  now: Date,
): Promise<ScheduledEvalOutcome> {
  const base = { suite: schedule.suite, mode: schedule.mode, pool: schedule.pool };
  runtime.events.emit({ kind: STARTED_EVENT, actor: "daemon", payload: { ...base, at: now.toISOString() } });
  let outcome: ScheduledEvalOutcome;
  try {
    const result = await (options.run ?? runSuite)(suiteDirOf(runtime, options.cwd, schedule.suite), {
      homeDir: options.homeDir,
      env: options.env,
      mode: schedule.mode,
      pool: schedule.pool,
    });
    const file = join(options.cwd, "evals", "results", `${result.at.slice(0, 10)}-${result.suite}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    const baselineFile = join(options.cwd, "evals", "baseline", `${result.suite}.json`);
    const baseline = existsSync(baselineFile)
      ? (JSON.parse(readFileSync(baselineFile, "utf8")) as SuiteResult)
      : undefined;
    const diff = baseline ? diffResults(baseline, result, schedule.tolerance) : undefined;
    outcome = {
      ...base,
      at: result.at,
      file,
      summary: result.summary,
      ...(baseline ? { baseline: baseline.at } : {}),
      regressed: diff ? !diff.ok : false,
      regressions: diff?.regressions ?? [],
    };
  } catch (error) {
    outcome = {
      ...base,
      at: new Date().toISOString(),
      regressed: false,
      regressions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  runtime.events.emit({ kind: FINISHED_EVENT, actor: "daemon", payload: { ...outcome } });
  return outcome;
}

/** The daemon's part: every schedule that is due and not running now, one after another. */
export async function runDueEvals(
  runtime: Runtime,
  options: ScheduledEvalsOptions,
  now: Date,
): Promise<ScheduledEvalOutcome[]> {
  const out: ScheduledEvalOutcome[] = [];
  for (const schedule of schedulesOf(runtime)) {
    const state = scheduleState(runtime, schedule, now);
    if (state.running || !state.next || state.next.getTime() > now.getTime()) continue;
    out.push(await runScheduledEval(runtime, schedule, options, now));
  }
  return out;
}

/** The latest outcome of each scheduled suite that regressed (or failed to run): the Runs page's notice. */
export function scheduledEvalNotices(runtime: Runtime): ScheduledEvalOutcome[] {
  const latest = new Map<string, ScheduledEvalOutcome>();
  for (const e of runtime.events.list({ kind: FINISHED_EVENT, limit: 1_000_000 })) {
    const p = e.payload as unknown as ScheduledEvalOutcome | undefined;
    if (p?.suite) latest.set(p.suite, p);
  }
  return [...latest.values()].filter((o) => o.regressed || o.error !== undefined);
}
