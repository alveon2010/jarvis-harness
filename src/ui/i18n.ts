import { AsyncLocalStorage } from "node:async_hooks";
import { escapeHtml, Html, html, type Part } from "./html.ts";
import { RU, RU_PLURALS } from "./i18n/ru.ts";

/**
 * The page's language: English as written in the code, Russian from a dictionary written by hand
 * (src/ui/i18n/ru.ts) — not machine translation. A string is its own key: what has no translation
 * stays English, so a screen can be translated one string at a time. Names of steps and workflows,
 * commands, ids, paths, and what agents and tools wrote are not translated.
 *
 * The language of a request is set once around its handler (src/ui/server.ts) and read here, so the
 * renderers need no parameter for it.
 */
export type Lang = "en" | "ru";
export const LANGS: readonly Lang[] = ["en", "ru"];
export const LANG_COOKIE = "jarvis_lang";

const current = new AsyncLocalStorage<Lang>();

/** Runs `fn` with `lang` as the language of everything it renders. */
export function inLang<T>(lang: Lang, fn: () => T): T {
  return current.run(lang, fn);
}

export function lang(): Lang {
  return current.getStore() ?? "en";
}

/** The language a cookie names, English otherwise. */
export function langOf(cookie: string | undefined): Lang {
  return cookie === "ru" ? "ru" : "en";
}

/**
 * The string in the page's language, `{name}` filled from `vars`. The key is the English string with
 * its placeholders: `t("Round {n} of {m}", { n: 2, m: 3 })`.
 */
export function t(key: string, vars?: Readonly<Record<string, string | number>>): string {
  const text = lang() === "ru" ? (RU[key] ?? key) : key;
  return vars
    ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all))
    : text;
}

/** Russian plural form: 1 прогон, 2 прогона, 5 прогонов, 21 прогон. */
export function ruForm(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/**
 * `n` with its noun in the page's language: `plural(3, "run")` — «3 runs», «3 прогона». The noun is the
 * English singular; its Russian forms are in RU_PLURALS, else English stays.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  if (lang() === "ru") {
    const forms = RU_PLURALS[one];
    if (forms) {
      const form = ruForm(n, forms);
      // a phrase with the number inside: «осталось {n} круга»
      return form.includes("{n}") ? form.replace("{n}", String(n)) : `${n} ${form}`;
    }
  }
  return `${n} ${n === 1 ? one : many}`;
}

/** `3m 12s`, `1h 04m`, `2d` in the page's language: «3 мин 12 с», «1 ч 04 мин», «2 д». */
export function units(text: string): string {
  if (lang() !== "ru") return text;
  const ru: Record<string, string> = { d: "д", h: "ч", m: "мин", s: "с", ms: "мс" };
  return text.replace(/(\d)(ms|d|h|m|s)\b/g, (_, digit: string, unit: string) => `${digit} ${ru[unit]}`);
}

/** `14:45 (in 6 min)` in the page's language (src/app/budgetWait.ts writes it in English). */
export function when(text: string): string {
  if (lang() !== "ru") return text;
  return text
    .replace("when the window frees", "когда окно освободится")
    .replace("(any moment now)", "(вот-вот)")
    .replace(/\(in (\d+) min\)/, "(через $1 мин)");
}

/**
 * A whole sentence with markup inside, in the page's language: the placeholders take code, links,
 * names — `th('Written in {file}.', { file: html`<code>${path}</code>` })` —
 * so the sentence is translated as one, not in pieces around its code.
 */
export function th(key: string, vars: Readonly<Record<string, Part>> = {}): Html {
  const text = lang() === "ru" ? (RU[key] ?? key) : key;
  const parts = text.split(/(\{\w+\})/);
  return new Html(
    parts
      .map((p) => {
        const m = /^\{(\w+)\}$/.exec(p);
        if (!m || !((m[1] as string) in vars)) return escapeHtml(p);
        return html`${vars[m[1] as string]}`.value;
      })
      .join(""),
  );
}
