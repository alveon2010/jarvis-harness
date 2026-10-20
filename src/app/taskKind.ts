import type { TaskKind } from "../core/domain/run.ts";

/**
 * The kind of a task (ADR-0020 §1), decided the same way on the page, in the CLI and in the run: what the
 * person picked; else the workflow's own kind (`fix`); else the words of the task; else `change`. The
 * words are plain rules, no model — the same text always gives the same kind, in English and Russian.
 */
export interface KindChoice {
  readonly kind: TaskKind;
  /** `person` — picked at the start; `workflow` — the workflow's own; `words` — by `word`; `default`. */
  readonly by: "person" | "workflow" | "words" | "default";
  /** The word of the task that decided it (`by: words`). */
  readonly word?: string;
}

// a word starts after a non-letter: `\b` knows no Cyrillic
const w = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})`, "iu");

/** First rule that matches wins: the narrower kinds before the wider ones. */
const RULES: ReadonlyArray<{ readonly kind: TaskKind; readonly re: RegExp }> = [
  { kind: "refactor", re: w("refactor\\p{L}*|рефактор\\p{L}*") },
  { kind: "docs", re: w("readme|docs?(?![\\p{L}])|documentation|документаци\\p{L}*") },
  {
    kind: "test",
    re: w(
      "(?:write|add|cover)\\p{L}*\\s+(?:\\p{L}+\\s+)?(?:unit\\s+)?tests?|(?:напис|добав|покр)\\p{L}*\\s+(?:\\p{L}+\\s+)?тест\\p{L}*|test coverage|покрытие тест\\p{L}*",
    ),
  },
  {
    kind: "fix",
    re: w(
      "bug\\p{L}*|fix(?:es|ed|ing)?(?![\\p{L}])|broken|crash\\p{L}*|regression|баг\\p{L}*|ошибк\\p{L}*|исправ\\p{L}*|не работает|не открывается|не сохраняется|падает|сломал\\p{L}*|регресс\\p{L}*",
    ),
  },
  {
    kind: "feature",
    re: w(
      "add(?:s|ed|ing)?(?![\\p{L}])|new(?![\\p{L}])|implement\\p{L}*|support(?![\\p{L}])|добав\\p{L}*|нов(?:ый|ая|ое|ые|ую|ого)|реализ\\p{L}*|поддерж\\p{L}*",
    ),
  },
];

/** The kind the words of a task say, with the word; nothing when they say none. */
export function kindOfWords(task: string): { readonly kind: TaskKind; readonly word: string } | undefined {
  for (const r of RULES) {
    const m = r.re.exec(task);
    if (m) return { kind: r.kind, word: m[0].trim().toLowerCase() };
  }
  return undefined;
}

export function kindOfTask(input: {
  readonly task: string;
  readonly picked?: TaskKind | undefined;
  readonly workflowKind?: TaskKind | undefined;
}): KindChoice {
  if (input.picked) return { kind: input.picked, by: "person" };
  if (input.workflowKind) return { kind: input.workflowKind, by: "workflow" };
  const words = kindOfWords(input.task);
  if (words) return { kind: words.kind, by: "words", word: words.word };
  return { kind: "change", by: "default" };
}
