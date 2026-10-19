/**
 * `tools.required`: the checks a project must have a command for. A check is met by a `tools.local`
 * command of its name or of its stem — `tests` by `test`, `tests-unit` or `test:e2e`, `lint` by
 * `lint-web` — because `project.checks` runs every `test*`, `typecheck*` and `lint*` command too.
 */
export const DEFAULT_REQUIRED = ["tests"] as const;

/** The checks people usually set; those not required are optional and shown as such. */
export const USUAL_CHECKS = ["tests", "typecheck", "lint"] as const;

const stemOf = (check: string): string => (check === "tests" ? "test" : check);

export function hasCheck(check: string, commands: Iterable<string>): boolean {
  const stem = stemOf(check);
  for (const name of commands) if (name === check || name.startsWith(stem)) return true;
  return false;
}

/** Of `required`, the checks no command meets. */
export function missingChecks(required: readonly string[], commands: Iterable<string>): string[] {
  const names = [...commands];
  return required.filter((c) => !hasCheck(c, names));
}

/** Of the usual checks, those neither required nor set: shown, not asked for. */
export function optionalUnset(required: readonly string[], commands: Iterable<string>): string[] {
  const names = [...commands];
  return USUAL_CHECKS.filter((c) => !required.includes(c) && !hasCheck(c, names));
}
