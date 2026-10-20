import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type RunCaseOptions, restrictToPool, type SuiteResult } from "../../src/evals/runner.ts";
import {
  FINISHED_EVENT,
  nextCron,
  runDueEvals,
  scheduledEvalNotices,
  scheduleState,
  schedulesOf,
} from "../../src/evals/schedule.ts";
import { daemonTick } from "../../src/orchestration/daemon.ts";
import type { RunsPage } from "../../src/ui/model.ts";
import { runsContent } from "../../src/ui/pages.ts";
import { engineFor, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0012 §5: the daemon runs a scheduled suite live on its own pool and says when it regressed. */
let sb: Sandbox;
let rt: Runtime | undefined;

afterEach(async () => {
  await rt?.close();
  rt = undefined;
  sb.cleanup();
});

const USER = `version: 1
quotaPools:
  team: { window: { minutes: 20, kind: sliding }, limits: { outputTokens: 60000 } }
  evals: { window: { minutes: 1440, kind: sliding }, limits: { outputTokens: 200000 } }
models:
  team-flash: { provider: openai-compatible, baseUrl: http://127.0.0.1:9/v1, model: flash, egress: private, quotaPool: team, contextWindow: 32000, maxOutput: 2000 }
  evals-flash: { provider: openai-compatible, baseUrl: http://127.0.0.1:9/v1, model: flash, egress: private, quotaPool: evals, contextWindow: 32000, maxOutput: 2000 }
roles:
  research: { models: [team-flash, evals-flash] }
  review: { models: [team-flash] }
evals:
  schedule: { suite: smoke, every: 24h, pool: evals }
`;

function result(successes: number, cases = 2): SuiteResult {
  return {
    suite: "smoke",
    mode: "live",
    variant: {},
    at: new Date().toISOString(),
    cases: [],
    summary: {
      cases,
      successes,
      successRate: successes / cases,
      meanFileRecall: 1,
      meanAcceptanceCoverage: 1,
      outputTokens: 10_000,
      successPer10k: successes,
    },
  };
}

async function setup(): Promise<Runtime> {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", USER);
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  sb.write("project/evals/baseline/smoke.json", JSON.stringify(result(2)));
  rt = await testRuntime(sb);
  return rt;
}

describe("scheduled evals", () => {
  it("runs a due suite on its pool only, writes the result, and a regression becomes a notice", async () => {
    const runtime = await setup();
    const calls: RunCaseOptions[] = [];
    let next = result(2);
    const options = {
      cwd: sb.project,
      homeDir: sb.home,
      env: {},
      run: async (dir: string, o: RunCaseOptions) => {
        expect(dir).toBe(join(sb.project, "evals", "smoke"));
        calls.push(o);
        return next;
      },
    };
    const t0 = new Date("2026-10-20T10:00:00Z");
    const [schedule] = schedulesOf(runtime);
    if (!schedule) throw new Error("schedule");
    // never ran: due now
    expect(scheduleState(runtime, schedule, t0).next?.getTime()).toBe(t0.getTime());
    const first = await runDueEvals(runtime, options, t0);
    expect(first).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: "live", pool: "evals" });
    expect(first[0]).toMatchObject({ suite: "smoke", regressed: false, regressions: [] });
    expect(existsSync(first[0]?.file as string)).toBe(true);
    expect(scheduledEvalNotices(runtime)).toEqual([]);

    // within the period: nothing to do
    expect(await runDueEvals(runtime, options, new Date("2026-10-20T20:00:00Z"))).toEqual([]);
    expect(scheduleState(runtime, schedule, t0).next?.toISOString()).toBe("2026-10-21T10:00:00.000Z");

    // the next day it regressed: the daemon's tick runs it, the Runs page says so
    next = result(1);
    const engine = engineFor(runtime, []);
    const tick = await daemonTick(runtime, engine, {
      clock: () => new Date("2026-10-21T10:00:30Z"),
      evals: options,
    });
    expect(tick.evals?.[0]).toMatchObject({
      regressed: true,
      regressions: ["successRate: 1 → 0.5", "successPer10k: 2 → 1"],
    });
    const saved = JSON.parse(readFileSync(tick.evals?.[0]?.file as string, "utf8")) as SuiteResult;
    expect(saved.summary.successes).toBe(1);
    expect(runtime.events.list({ kind: FINISHED_EVENT })).toHaveLength(2);
    const notices = scheduledEvalNotices(runtime);
    expect(notices.map((n) => n.suite)).toEqual(["smoke"]);
    const page = {
      repos: [],
      waiting: [],
      candidates: [],
      running: [],
      recent: { runs: [], query: "", terms: [], page: 1, pageSize: 20, total: 0 },
      today: { runs: 0, modelCalls: 0 },
      evalCandidates: [],
      evalNotices: notices,
    } as unknown as RunsPage;
    expect(String(runsContent(page, Date.now()))).toContain(
      "suite <b>smoke</b> regressed against its baseline",
    );
  });

  it("restricts the models to the schedule's pool: a role with none left is dropped", async () => {
    sb = sandbox();
    sb.write("home/.jarvis/config.yaml", USER);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const only = restrictToPool(loaded, "evals");
    expect(Object.keys(only.config.models)).toEqual(["evals-flash"]);
    expect(only.config.roles).toEqual({ research: { models: ["evals-flash"] } });
    expect(() => restrictToPool(loaded, "team-2")).toThrow(/no quota pool/);
  });

  it("a schedule on a pool the machine does not define is a configuration error", async () => {
    sb = sandbox();
    sb.write("home/.jarvis/config.yaml", USER.replace("pool: evals", "pool: nightly"));
    await expect(loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} })).rejects.toThrow(
      /unknown quota pool "nightly"/,
    );
  });

  it("cron: the next minute it names, in local time", () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);
    expect(nextCron("30 3 * * *", at(2026, 10, 20, 10, 0))).toEqual(at(2026, 10, 21, 3, 30));
    // 24.10.2026 is a Saturday: the next weekday is Monday
    expect(nextCron("0 4 * * 1-5", at(2026, 10, 24, 0, 0))).toEqual(at(2026, 10, 26, 4, 0));
    expect(nextCron("*/15 * * * *", at(2026, 10, 20, 10, 7))).toEqual(at(2026, 10, 20, 10, 15));
    expect(() => nextCron("61 * * * *", at(2026, 10, 20, 10, 0))).toThrow(/out of range/);
  });
});
