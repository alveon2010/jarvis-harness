import { describe, expect, it } from "vitest";
import { runShell, windowsCommandLine } from "../../src/tools/local/exec.ts";

describe("windowsCommandLine (cmd.exe reads / as a switch)", () => {
  it("turns ./ and ../ command words into backslashes, nothing else", () => {
    expect(windowsCommandLine("./gradlew test")).toBe(".\\gradlew test");
    expect(windowsCommandLine("./gradlew classes testClasses -q")).toBe(".\\gradlew classes testClasses -q");
    expect(windowsCommandLine("cd api && ../tools/build.cmd --out a/b")).toBe(
      "cd api && ..\\tools\\build.cmd --out a/b",
    );
    expect(windowsCommandLine("(./a) || ./b/c | ./d &./e")).toBe("(.\\a) || .\\b\\c | .\\d &.\\e");
    expect(windowsCommandLine("pnpm vitest run src/a.test.ts")).toBe("pnpm vitest run src/a.test.ts");
    expect(windowsCommandLine('echo "./x"')).toBe('echo "./x"');
  });
});

describe.skipIf(process.platform === "win32")("runShell output lines", () => {
  it("hands over each non-empty line, without colours, as it comes", async () => {
    const seen: string[] = [];
    const r = await runShell("printf 'one\\n\\033[32mtwo\\033[0m\\n\\n' ; printf 'three\\n' >&2", {
      cwd: process.cwd(),
      onLine: (l) => seen.push(l),
    });
    expect(r.code).toBe(0);
    expect(seen.sort()).toEqual(["one", "three", "two"]);
  });
});
