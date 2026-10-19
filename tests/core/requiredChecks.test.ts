import { describe, expect, it } from "vitest";
import { hasCheck, missingChecks, optionalUnset } from "../../src/core/config/requiredChecks.ts";

/** tools.required: which checks a project must have a command for. */
describe("required checks", () => {
  it("a check is met by its name or its stem: tests by test, test:e2e; lint by lint-web", () => {
    expect(hasCheck("tests", ["test"])).toBe(true);
    expect(hasCheck("tests", ["test:e2e"])).toBe(true);
    expect(hasCheck("lint", ["lint-web"])).toBe(true);
    expect(hasCheck("typecheck", ["lint"])).toBe(false);
    expect(hasCheck("publish-local", ["publish-local"])).toBe(true);
  });

  it("missing: required with no command; optional: the usual ones neither required nor set", () => {
    expect(missingChecks(["tests", "lint"], ["test", "typecheck"])).toEqual(["lint"]);
    expect(optionalUnset(["tests"], ["test"])).toEqual(["typecheck", "lint"]);
    expect(optionalUnset(["tests", "typecheck"], ["test", "lint"])).toEqual([]);
  });
});
