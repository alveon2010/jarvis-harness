import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fillServiceEntry, kindOf } from "../../src/onboarding/serviceEntry.ts";

const MAP = `version: 1
# shared
tools:
  local:
    lint: ./gradlew spotlessCheck
services:
  orders-api: {}                # gradle
  notify-api:
    tools: { local: { tests: "TZ=UTC ./gradlew test" } }   # set by hand
`;

const gradle = [
  { name: "tests", command: "./gradlew test" },
  { name: "typecheck", command: "./gradlew classes testClasses -q" },
  { name: "lint", command: "./gradlew check" },
];

describe("a service's entry in the map, from the scan", () => {
  it("kind by the stack", () => {
    expect(kindOf(["java"])).toBe("backend");
    expect(kindOf(["node", "react", "typescript"])).toBe("frontend");
    expect(kindOf(["node", "typescript"])).toBe("backend");
    expect(kindOf([])).toBeUndefined();
  });

  it("an empty entry gets its kind and commands, but not what the shared configuration sets", () => {
    const r = fillServiceEntry(MAP, "orders-api", { kind: "backend", commands: gradle });
    expect(r.added).toEqual(["kind", "tools.local.tests", "tools.local.typecheck"]);
    expect(r.kept).toEqual(["tools.local.lint: shared"]);
    const v = parse(r.text);
    expect(v.services["orders-api"]).toEqual({
      kind: "backend",
      tools: { local: { tests: "./gradlew test", typecheck: "./gradlew classes testClasses -q" } },
    });
    expect(r.text).toContain("# shared");
    expect(r.text).not.toContain("# gradle");
  });

  it("what a person set stays, with its comment; only what is missing is added", () => {
    const r = fillServiceEntry(MAP, "notify-api", { kind: "backend", commands: gradle.slice(0, 2) });
    expect(r.added).toEqual(["kind", "tools.local.typecheck"]);
    expect(r.kept).toEqual(["tools.local.tests: the service's"]);
    expect(parse(r.text).services["notify-api"].tools.local.tests).toBe("TZ=UTC ./gradlew test");
    expect(r.text).toContain("# set by hand");
  });

  it("run again: nothing new, the same text", () => {
    const once = fillServiceEntry(MAP, "orders-api", { kind: "backend", commands: gradle.slice(0, 2) }).text;
    const twice = fillServiceEntry(once, "orders-api", { kind: "backend", commands: gradle.slice(0, 2) });
    expect(twice.added).toEqual([]);
    expect(twice.kept).toEqual([]);
    expect(twice.text).toBe(once);
  });
});
