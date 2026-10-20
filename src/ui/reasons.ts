import { lang, t } from "./i18n.ts";

/**
 * A run's `stateReason` in the page's language. The engine writes it in English for the journal and the
 * terminal; the common ones are said again here, the rest — a model's error, a check's output — stay as
 * they are.
 */
const FORMS: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
  [/^approve (\S+) \((.+)\)$/, (m) => t("approve {type} ({doc})", { type: m[1] ?? "", doc: m[2] ?? "" })],
  [
    /^clarification needed by (\S+): (\S+)$/,
    (m) => t("clarification needed by {agent}: {thread}", { agent: m[1] ?? "", thread: m[2] ?? "" }),
  ],
  [
    /^waits for its subtasks: (\d+) of (\d+) done$/,
    (m) => t("waits for its subtasks: {done} of {all} done", { done: m[1] ?? "", all: m[2] ?? "" }),
  ],
  [
    /^asks the master to change the contract: (.+)$/,
    (m) => t("asks the master to change the contract: {item}", { item: m[1] ?? "" }),
  ],
  [
    /^model (\S+) is unavailable: (.+)$/,
    (m) => t("model {model} is unavailable: {why}", { model: m[1] ?? "", why: m[2] ?? "" }),
  ],
  [
    /^interrupted with Ctrl-C; `jarvis continue` goes on from here$/,
    () => t("interrupted with Ctrl-C; `jarvis continue` goes on from here"),
  ],
  [
    /^paused(?: by (.+?))?; Resume \(or `jarvis continue`\) goes on from here$/,
    (m) =>
      m[1]
        ? t("paused by {who}; Resume (or `jarvis continue`) goes on from here", { who: m[1] })
        : t("paused; Resume (or `jarvis continue`) goes on from here"),
  ],
  [/^cancelled at a safe point$/, () => t("cancelled at a safe point")],
  [/^workflow done$/, () => t("workflow done")],
  [/^went on without the failed checks$/, () => t("went on without the failed checks")],
  [/^resumed from (\S+)$/, (m) => t("resumed from {state}", { state: m[1] ?? "" })],
  [/^started$/, () => t("started")],
];

export function reasonText(text: string): string {
  if (lang() === "en") return text;
  for (const [re, to] of FORMS) {
    const m = re.exec(text);
    if (m) return to(m);
  }
  return text;
}
