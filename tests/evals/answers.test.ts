import { describe, expect, it } from "vitest";
import { answerReflected, answersCoverage, keyTerms } from "../../src/evals/answers.ts";
import { diffResults, type SuiteResult } from "../../src/evals/runner.ts";

/** ADR-0012 §2: the person's answers to open questions, checked in the eval run's spec without a model. */
const spec = JSON.stringify({
  title: "Retry a declined payment",
  requirements: [
    {
      id: "R1",
      text: "payments-service retries a declined payment at most 3 times, then marks the order FAILED",
      acceptance: ["Повторные попытки списания идут с интервалом в пять минут"],
    },
  ],
});

describe("answersCoverage", () => {
  it("an answer the spec holds whole, or by most of its key terms, inflected, is reflected", () => {
    expect(answerReflected("at most 3 times", spec)).toBe(true);
    // «attempts» is not in the spec; «retries», «declined», «payment», «3» are: 4 of 5 terms
    expect(answerReflected("Retry declined payments, up to 3 attempts", spec)).toBe(true);
    // Russian inflection: «попытка», «интервалом пять минут»
    expect(answerReflected("Попытки с интервалом пять минут", spec)).toBe(true);
    expect(answerReflected("Refund the customer by email", spec)).toBe(false);
    // a digit is a word as it is: 5 is not 3
    expect(answerReflected("5", spec)).toBe(false);
  });

  it("an answer with nothing to check is not counted; none countable — no metric", () => {
    expect(keyTerms("Yes, that is all")).toEqual([]);
    expect(answerReflected("Да", spec)).toBeUndefined();
    const answers = (...xs: string[]) => xs.map((answer) => ({ question: "?", answer }));
    expect(answersCoverage(answers("yes", "no"), spec)).toBeUndefined();
    expect(answersCoverage(answers("at most 3 times", "Refund the customer by email", "ok"), spec)).toBe(0.5);
    expect(answersCoverage([], spec)).toBeUndefined();
  });

  it("evals diff compares answers coverage when both results have it", () => {
    const mk = (answers?: number): SuiteResult =>
      ({
        suite: "s",
        mode: "replay",
        variant: {},
        at: "",
        cases: [],
        summary: {
          cases: 2,
          successes: 2,
          successRate: 1,
          meanFileRecall: 1,
          meanAcceptanceCoverage: 1,
          ...(answers !== undefined ? { meanAnswersCoverage: answers } : {}),
          outputTokens: 1000,
          successPer10k: 20,
        },
      }) as SuiteResult;
    expect(diffResults(mk(1), mk(0.5)).regressions).toEqual(["meanAnswersCoverage: 1 → 0.5"]);
    // a baseline from before the metric: nothing to compare it with
    expect(diffResults(mk(), mk(0.5)).ok).toBe(true);
  });
});
