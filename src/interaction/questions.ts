import { z } from "zod";
import { type FrameName, humanizeNodeIds } from "../design/frames.ts";

/**
 * An open question of a document, as a person at the gate reads it: what is asked, about what — the
 * screen by its title, the field by its label —, and the answers in sight. Ids are for the tools.
 * A plain string is still a question (documents before this, and short ones).
 */
export const OpenQuestion = z.union([
  z.string().min(1),
  z.object({
    question: z
      .string()
      .min(1)
      .describe("asked so a person can answer it without opening any tool: no node ids, no requirement ids"),
    about: z
      .string()
      .optional()
      .describe(
        "what it is about as a person sees it: the screen by its title, the field by its label, the text in «»",
      ),
    options: z.array(z.string().min(1)).optional().describe("the answers you see, each a short full phrase"),
    refs: z
      .array(z.string())
      .optional()
      .describe("for the tools: Figma node ids, requirement ids, paths — never in the question"),
  }),
]);
export type OpenQuestionT = z.infer<typeof OpenQuestion>;

/** The question as one line for a person: the question, what it is about, the options. */
export function questionText(
  q: unknown,
  names: ReadonlyMap<string, FrameName> = new Map(),
): string | undefined {
  if (typeof q === "string") return q.trim() ? humanizeNodeIds(q.trim(), names) : undefined;
  if (!q || typeof q !== "object") return undefined;
  const o = q as { question?: unknown; about?: unknown; options?: unknown };
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) return undefined;
  const about = typeof o.about === "string" ? o.about.trim() : "";
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const line = [
    question,
    about && !question.includes(about) ? ` (${about})` : "",
    options.length > 0 ? ` — ${options.map((x) => x.trim()).join(" / ")}` : "",
  ].join("");
  return humanizeNodeIds(line, names);
}

/** A document's `openQuestions`, strings or objects, as lines. */
export function questionsOf(value: unknown, names?: ReadonlyMap<string, FrameName>): string[] {
  return Array.isArray(value)
    ? value.map((q) => questionText(q, names)).filter((q): q is string => q !== undefined)
    : [];
}
