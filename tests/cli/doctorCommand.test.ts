import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandExists } from "../../src/cli/commands/doctor.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

describe("doctor: the program a command runs", () => {
  it("looks past variables set for the command and a `cd <dir> &&`", () => {
    sb = sandbox();
    mkdirSync(join(sb.project, "svc"), { recursive: true });
    for (const f of ["gradlew", "svc/gradlew"]) {
      writeFileSync(join(sb.project, f), "#!/bin/sh\n");
      chmodSync(join(sb.project, f), 0o755);
    }
    const env = { PATH: process.env.PATH ?? "" };
    expect(commandExists("TZ=Europe/Paris ./gradlew test", env, sb.project)).toBe(true);
    expect(commandExists("cd svc && JAVA_OPTS=-Xmx1g ./gradlew test", env, sb.project)).toBe(true);
    expect(commandExists("cd other && ./gradlew test", env, sb.project)).toBe(false);
    expect(commandExists("A=1 sh -c true", env, sb.project)).toBe(true);
  });
});
