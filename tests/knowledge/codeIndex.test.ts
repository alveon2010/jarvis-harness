import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import {
  codeUnitsOf,
  identifierWords,
  isIndexableCode,
  MAX_UNIT_LINES,
  symbolSegments,
} from "../../src/knowledge/retrieval/code.ts";
import { refreshIndex, search } from "../../src/knowledge/retrieval/service.ts";
import { testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime | undefined;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });
const roots = () => ({ projectRoot: sb.project, userRoot: join(sb.home, ".jarvis") });

const ONBOARDING = `import { Application } from "./application";

/** Whether a rejected application may start over. */
export function canRestartOnboarding(app: Application): boolean {
  return app.status === "REJECTED" && app.restarts === 0;
}

export class OnboardingService {
  restart(app: Application) {
    if (!canRestartOnboarding(app)) throw new Error("no restart");
  }
}
`;

beforeEach(() => {
  sb = sandbox();
  rmSync(join(sb.project, ".git"), { recursive: true, force: true });
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/knowledge/glossary.md",
    "| термин | синонимы | символы/модули | источники | обновлено |\n|---|---|---|---|---|\n| повторная регистрация | restart onboarding | canRestartOnboarding | ABC-42 | 2026-10-01 |\n",
  );
  sb.write("project/src/onboarding.ts", ONBOARDING);
  sb.write(
    "project/src/payments/refund.ts",
    "export const refundOnce = (id: string) => ledger.refund(id);\n",
  );
  sb.write("project/node_modules/lib/index.js", "export function canRestartOnboarding() {}\n");
  sb.write("project/dist/onboarding.min.js", "function canRestartOnboarding(){}\n");
  sb.write("project/src/huge.ts", `export const blob = "${"x".repeat(5000)}";\n`);
  sb.write("project/src/blob.ts", "export const a = 1;\0\0binary");
  sb.write("project/README.md", "# orders-api\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A", "-f"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await rt?.close();
  rt = undefined;
  sb.cleanup();
});

describe("code as symbol units (ADR-0015 §2 v0.4)", () => {
  it("splits a file by its top-level declarations, comments attached", () => {
    const segs = symbolSegments(ONBOARDING);
    expect(segs.map((s) => [s.name, s.start, s.end])).toEqual([
      [undefined, 1, 2],
      ["canRestartOnboarding", 3, 7],
      ["OnboardingService", 8, 12],
    ]);
    const units = codeUnitsOf("src/onboarding.ts", "abc", ONBOARDING);
    expect(units[1]).toMatchObject({
      sourceId: "code:src/onboarding.ts#1",
      sourceVersion: "abc",
      kind: "code",
      title: "src/onboarding.ts — canRestartOnboarding",
      ref: "src/onboarding.ts:3-7",
    });
    expect(units[1]?.body).toContain("can restart onboarding");
  });

  it("splits a long declaration by its members and a file without any by windows", () => {
    const methods = Array.from({ length: 60 }, (_, i) => `  method${i}() {\n    return ${i};\n  }\n`).join(
      "",
    );
    const cls = `export class OrderRepository {\n${methods}}\n`;
    const segs = symbolSegments(cls);
    expect(segs[0]).toMatchObject({ name: "OrderRepository", start: 1, end: 1 });
    expect(segs[1]).toMatchObject({ name: "OrderRepository.method0", start: 2, end: 4 });
    expect(segs).toHaveLength(61);
    expect(segs.at(-1)).toMatchObject({ name: "OrderRepository.method59", end: 182 });
    const plain = Array.from({ length: MAX_UNIT_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    expect(symbolSegments(plain).map((s) => s.name)).toEqual(["lines (part 1)", "lines (part 2)"]);
    expect(symbolSegments("")).toEqual([]);
  });

  it("splits identifiers into words and skips what is not the project's code", () => {
    expect(identifierWords("canRestartOnboarding order_total HTTPServer x")).toBe(
      "can restart onboarding order total http server",
    );
    const config = { include: [], exclude: [] };
    expect(isIndexableCode("src/a.ts", config)).toBe(true);
    expect(isIndexableCode("node_modules/x/a.js", config)).toBe(false);
    expect(isIndexableCode("packages/x/dist/a.js", config)).toBe(false);
    expect(isIndexableCode("src/a.min.js", config)).toBe(false);
    expect(isIndexableCode("src/types.d.ts", config)).toBe(false);
    expect(isIndexableCode("README.md", config)).toBe(false);
    expect(isIndexableCode("logo.png", config)).toBe(false);
    expect(isIndexableCode("src/a.ts", { include: ["lib/**"], exclude: [] })).toBe(false);
    expect(isIndexableCode("src/gen/a.ts", { include: [], exclude: ["src/gen/**"] })).toBe(false);
    expect(isIndexableCode("src/secrets/a.ts", config, (p) => p.startsWith("src/secrets/"))).toBe(false);
  });

  it("indexes tracked source files incrementally and finds code by words and glossary terms", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nknowledge: { retrieval: { code: { maxFileBytes: 2000 } } }\n",
    );
    rt = await testRuntime(sb);
    const first = await refreshIndex(rt, roots());
    // onboarding, refund, huge (too large), blob (binary); node_modules, dist and README never taken
    expect(first.code).toEqual({ files: 4, changed: 2, skipped: 2 });

    // a business term in Russian finds the function through the glossary
    const term = await search(rt, roots(), "повторная регистрация после отказа", { kinds: ["code"] });
    expect(term.evidence[0]?.ref).toBe("src/onboarding.ts:3-7");
    expect(term.evidence[0]?.title).toBe("src/onboarding.ts — canRestartOnboarding");
    // plain words find it too: identifiers are split for the index
    const words = await search(rt, roots(), "restart onboarding rejected", { kinds: ["code"] });
    expect(words.evidence.map((e) => e.ref)).toContain("src/onboarding.ts:3-7");
    expect((await search(rt, roots(), "ledger refund")).evidence[0]?.ref).toBe("src/payments/refund.ts:1-1");

    // nothing changed: no file is read again
    const again = await refreshIndex(rt, roots());
    expect(again.code?.changed).toBe(0);
    expect(again.indexed).toBe(0);

    // a change in the working copy is indexed by content; a deleted file's units are pruned
    sb.write("project/src/payments/refund.ts", "export const refundTwice = () => chargeback();\n");
    git(["rm", "-q", "src/onboarding.ts"]);
    const third = await refreshIndex(rt, roots());
    expect(third.code?.changed).toBe(1);
    expect(third.removed).toBe(3);
    expect((await search(rt, roots(), "chargeback")).evidence[0]?.ref).toBe("src/payments/refund.ts:1-1");
    expect((await search(rt, roots(), "canRestartOnboarding", { kinds: ["code"] })).evidence).toEqual([]);
    await rt.close();

    // code off: its units leave the index
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nknowledge: { retrieval: { code: false } }\n",
    );
    rt = await testRuntime(sb);
    const off = await refreshIndex(rt, roots());
    expect(off.code).toBeUndefined();
    expect((await search(rt, roots(), "chargeback")).evidence).toEqual([]);
  });

  it("reports the code it indexed from the CLI", async () => {
    let out = "";
    const code = await run(["node", "jarvis", "knowledge", "index"], {
      streams: {
        out: new Writable({
          write(c, _e, cb) {
            out += String(c);
            cb();
          },
        }),
        err: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
      context: { cwd: sb.project, homeDir: sb.home, env: {} },
    });
    expect(code).toBe(0);
    expect(out).toContain("code: 4 file(s), 3 read again, 1 skipped");
  });
});
