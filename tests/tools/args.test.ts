import { describe, expect, it } from "vitest";
import { projectArgs, quoteArg, splitArgs } from "../../src/tools/local/args.ts";

/** An agent's args to a project command are words for the command, never shell. */
describe("project command args", () => {
  it("splits like a shell: quotes and backslashes hold a word together", () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g --x="h|i"`)).toEqual(["a", "b c", "d e", "f g", "--x=h|i"]);
    expect(splitArgs(`"open`)).toBeUndefined();
    expect(splitArgs("  ")).toEqual([]);
  });

  it("quotes what the shell would read otherwise", () => {
    expect(quoteArg("src/a.test.ts")).toBe("src/a.test.ts");
    expect(quoteArg("$(rm -rf .)")).toBe("'$(rm -rf .)'");
    expect(quoteArg("it's")).toBe(`'it'\\''s'`);
    expect(projectArgs(`--testPathPattern="saga|reducer" src/a.ts`)).toEqual({
      ok: true,
      text: "'--testPathPattern=saga|reducer' src/a.ts",
    });
  });

  it("refuses pipes, redirects and chains", () => {
    for (const raw of ["2>&1 | tail -120", "-- --quiet && echo", "x ; y", "> out.txt", "a || b"]) {
      const r = projectArgs(raw);
      expect(r.ok, raw).toBe(false);
    }
    expect(projectArgs("'a | b'").ok).toBe(true);
  });
});
