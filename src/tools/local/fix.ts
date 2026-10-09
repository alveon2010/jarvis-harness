import { globMatches } from "../../knowledge/frontmatter.ts";
import { quoteArg } from "./args.ts";

/** A `tools.fix` or `tools.checks` rule: the `tools.local` command `run` for the files matching `when`. */
export interface FileRule {
  readonly when: readonly string[];
  readonly run: string;
}

/** `cd <dir> && …`: the package directory a command runs in; undefined — the checkout's root. */
export function packageDirOf(command: string): string | undefined {
  return /^\s*cd\s+([^\s&;]+)\s*&&/.exec(command)?.[1]?.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Files of the checkout as the command sees them: relative to its package, quoted for the shell. */
export function filesFor(command: string, files: readonly string[]): string {
  const dir = packageDirOf(command);
  return files.map((f) => quoteArg(dir && f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : f)).join(" ");
}

/** Per rule's command, the files it takes, in the order of the config (each command once). */
export function rulesFor(
  rules: readonly FileRule[],
  files: readonly string[],
): Array<{ run: string; files: string[] }> {
  const out: Array<{ run: string; files: string[] }> = [];
  for (const rule of rules) {
    const matched = files.filter((f) => globMatches(f, rule.when));
    if (matched.length === 0) continue;
    const same = out.find((o) => o.run === rule.run);
    if (same) same.files.push(...matched.filter((f) => !same.files.includes(f)));
    else out.push({ run: rule.run, files: matched });
  }
  return out;
}
