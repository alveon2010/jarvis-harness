/**
 * Arguments an agent appends to a `tools.local` command (`project.<name>`, `args`). They are words for
 * the command, not shell: each is quoted, and a pipe, a redirect or a chain is refused. Pilot: agents
 * appended `2>&1 | tail -120` and `| grep …` — the command line went to /bin/sh as it was, so any
 * command could ride along in the checkout.
 */

const OPERATOR = /^(?:\|\|?|&&?|;;?|\|&|\d*>>?|\d*>&\d*|<<?<?|&>>?)$/;
const PLAIN = /^[A-Za-z0-9_./:=@%+,^-]+$/;

/** One word for /bin/sh, as itself. */
export function quoteArg(word: string): string {
  return PLAIN.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Words as a shell would split them: whitespace between, quotes and backslashes kept together. */
export function splitArgs(raw: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let open = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] as string;
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word += raw.slice(i + 1, end);
      open = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < raw.length && raw[j] !== '"'; j += 1) {
        if (raw[j] === "\\" && j + 1 < raw.length && /["\\$`]/.test(raw[j + 1] as string)) j += 1;
        word += raw[j];
      }
      if (j >= raw.length) return undefined;
      open = true;
      i = j;
    } else if (c === "\\" && i + 1 < raw.length) {
      word += raw[i + 1];
      open = true;
      i += 1;
    } else if (/\s/.test(c)) {
      if (open) words.push(word);
      word = "";
      open = false;
    } else {
      word += c;
      open = true;
    }
  }
  if (open) words.push(word);
  return words;
}

export type ProjectArgs =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/** The agent's `args` as quoted words for the command line, or why they are refused. */
export function projectArgs(raw: string): ProjectArgs {
  const words = splitArgs(raw);
  if (!words) return { ok: false, error: "args: an unclosed quote" };
  const operator = words.find((w) => OPERATOR.test(w));
  if (operator)
    return {
      ok: false,
      error: `args are arguments for the command, not shell: "${operator}" is not run — no pipes, redirects or chains. The output comes back whole (cut to its end when long); pass the command's own options to narrow it (a file, a test path, --quiet).`,
    };
  return { ok: true, text: words.map(quoteArg).join(" ") };
}
