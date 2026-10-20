/**
 * `answersCoverage` (ADR-0012 §2): the share of a person's answers to the documents' open questions
 * (`gold.answers`, from `run-to-case`) that the spec of the eval run reflects. Deterministic, no model:
 *
 * 1. Both texts are normalized: NFKC, lower case, `ё` → `е`, every run of characters that are not letters
 *    or digits → one space.
 * 2. An answer whose normalized text the spec contains whole (on word boundaries) is reflected.
 * 3. Otherwise its key terms count: the distinct words of four letters or more, or with a digit, that are
 *    not common function words. A word term is found when a spec word begins with its stem — its first
 *    `len - 2` characters, at least 4 and at most 6 (`attempts` → `attemp`, `попытки` → `попыт`), so
 *    inflections and plurals match; a term with a digit must be a spec word as it is. The answer is
 *    reflected when at least three quarters of its key terms are found.
 * 4. An answer with no key terms («yes», «да», «ok») says nothing the spec can be checked for: it is not
 *    counted. A case with no countable answer has no `answersCoverage`.
 */
export interface GoldAnswer {
  readonly question: string;
  readonly answer: string;
}

/** The share of found key terms an answer needs to count as reflected. */
export const ANSWER_TERMS_NEEDED = 0.75;

const STOP = new Set(
  [
    // English
    "about after also and any been before being both but can cannot could does done each even every from have here into just like more most must need only other over same should since some such than that their them then there these they this those through very want were what when where which while will with would your",
    // Russian
    "будет будут было быть вместо всегда всех даже если есть затем здесь иначе как когда либо лишь между много можно надо нужно нужна нужен него нельзя никогда ними один одна она они оно перед после потом почему пусть раньше сейчас слишком снова также такой такие только тоже уже чем чтобы через этим этого этой этот эти должен должна должно должны",
  ]
    .join(" ")
    .split(" "),
);

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of an answer the spec must carry for it to count as reflected (rule 3). */
export function keyTerms(answer: string): string[] {
  const words = normalizeText(answer).split(" ").filter(Boolean);
  return [...new Set(words.filter((w) => (w.length >= 4 || /\p{N}/u.test(w)) && !STOP.has(w)))];
}

function stemOf(term: string): string {
  return term.slice(0, Math.min(6, Math.max(4, term.length - 2)));
}

/** Whether the spec reflects one answer: undefined when the answer has nothing to check (rule 4). */
export function answerReflected(answer: string, spec: string): boolean | undefined {
  const whole = normalizeText(answer);
  if (!whole) return undefined;
  const text = ` ${normalizeText(spec)} `;
  if (text.includes(` ${whole} `)) return true;
  const terms = keyTerms(answer);
  if (terms.length === 0) return undefined;
  const words = text.split(" ").filter(Boolean);
  const found = terms.filter((t) =>
    /\p{N}/u.test(t) ? words.includes(t) : words.some((w) => w.startsWith(stemOf(t))),
  ).length;
  return found / terms.length >= ANSWER_TERMS_NEEDED;
}

/** The share of countable answers the spec reflects; undefined when no answer is countable. */
export function answersCoverage(answers: readonly GoldAnswer[], spec: string): number | undefined {
  const checked = answers
    .map((a) => answerReflected(a.answer, spec))
    .filter((x): x is boolean => x !== undefined);
  if (checked.length === 0) return undefined;
  return checked.filter(Boolean).length / checked.length;
}
