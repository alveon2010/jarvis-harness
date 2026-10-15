/**
 * Code references on the pages: a file with lines (`src/main/java/…/OrderService.java:44-62`) and a
 * symbol (`AbstractOrderService.correctDeliverySlots`). Long ones do not fit a column and break
 * anywhere in the middle, so they are shortened by their parts — the path keeps its source set and
 * the last folder, the symbol keeps its type and member — with the whole in the tooltip; each part is
 * a unit of its own, so a line wraps between the type and the member, not in the middle of a name.
 * A file opens in the editor: `/open?path=…&line=…` on the `jarvis ui` server finds it in the run's
 * checkout and redirects to the `editor` of `~/.jarvis/config.yaml`.
 */
import { escapeHtml } from "./html.ts";

/** Extensions a file reference ends with; anything else with a dot and no slash is a symbol. */
const CODE_EXT =
  "java|kt|kts|groovy|scala|gradle|ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|go|rs|rb|php|cs|swift|c|h|cc|cpp|hpp|m|sql|graphql|gql|proto|md|adoc|yaml|yml|json|xml|properties|toml|ini|env|csv|html|css|scss|less|sh|bash|feature|avsc|txt|lock";
const FILE = new RegExp(
  `^((?:[\\w.@~-]+\\/)*[\\w@~-][\\w.@~-]*\\.(?:${CODE_EXT}))(?::(\\d+)(?:[-–](\\d+))?)?(?:#([\\w$.<>/]+))?$`,
);
/** `pkg.Type.member`, `Type#member/2`, `Type::member`, `member()`: identifiers joined by `.`, `#`, `::`. */
const SYMBOL = /^[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$<>]*)+(?:\/\d+|\(\))?$/;
/** A bare `File.java:12` (or `…-20`) in prose. */
const BARE_FILE_LINE = new RegExp(
  `(^|[\\s(\\[«])((?:[\\w.@~-]+\\/)*[\\w@~-][\\w.@~-]*\\.(?:${CODE_EXT})):(\\d+)(?:[-–](\\d+))?(?=$|[\\s),.;:\\]»])`,
  "g",
);

const LONG_PATH = 40;
const LONG_SYMBOL = 32;
/** A JVM / Gradle source set root: `src/main/java`, `src/test/resources`, `src/integrationTest/kotlin`. */
const SOURCE_SET = /^src\/[\w-]+\/(?:java|kotlin|groovy|scala|resources)$/;

/** Break opportunities after separators (`a.b`, `a/b`): a long name wraps there, not anywhere. */
function breakable(escaped: string): string {
  return escaped.replace(/([./#:_-])(?=[^./#:_-])/g, "$1<wbr>");
}

/** `src/main/java/com/example/orders/util/SlotReader.java` → `src/main/java/…/util/` and `SlotReader.java`. */
export function shortPath(path: string): { readonly dir: string; readonly name: string } {
  const parts = path.split("/");
  const name = parts.pop() as string;
  if (parts.length === 0) return { dir: "", name };
  const dir = `${parts.join("/")}/`;
  if (path.length <= LONG_PATH || parts.length <= 2) return { dir, name };
  const head = SOURCE_SET.test(parts.slice(0, 3).join("/")) ? 3 : 1;
  if (parts.length <= head + 1) return { dir, name };
  return { dir: `${parts.slice(0, head).join("/")}/…/${parts.at(-1)}/`, name };
}

/**
 * `com.example.orders.service.OrderService.place` → qualifier `…service.OrderService.`, member `place`: the
 * packages fold to the last one; the type stays (the member alone says little).
 */
export function shortSymbol(symbol: string): { readonly qualifier: string; readonly member: string } {
  const m = /^(.*?)(\.|#|::)([^.#:]+)$/.exec(symbol);
  if (!m) return { qualifier: "", member: symbol };
  let qualifier = `${m[1]}${m[2]}`;
  const member = m[3] as string;
  if (symbol.length > LONG_SYMBOL) {
    const segs = (m[1] as string).split(".");
    const firstType = segs.findIndex((s) => /^[A-Z]/.test(s));
    if (firstType > 1) qualifier = `…${segs.slice(firstType - 1).join(".")}${m[2]}`;
  }
  return { qualifier, member };
}

/** The `/open` link of a file and line. */
export function openHref(path: string, line?: number): string {
  return `/open?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`;
}

/** A file (and lines) as a link to the editor; the whole path in the tooltip. */
export function fileRefHtml(path: string, line?: number, end?: number, symbol?: string): string {
  const { dir, name } = shortPath(path);
  const lines = line ? `:${line}${end ? `-${end}` : ""}` : "";
  const sym = symbol ? `#${symbol}` : "";
  const full = `${path}${lines}${sym}`;
  return `<a class="ref" href="${escapeHtml(openHref(path, line))}" title="${escapeHtml(`${full} — open in the editor`)}"><code>${
    dir ? `<span class="cq">${breakable(escapeHtml(dir))}</span>` : ""
  }<span>${escapeHtml(name)}${lines ? `<span class="cq">${escapeHtml(lines)}</span>` : ""}</span>${
    sym ? `<span class="cq">${breakable(escapeHtml(sym))}</span>` : ""
  }</code></a>`;
}

/** A symbol: the qualifier muted, the member plain, wrapping between them; the whole in the tooltip. */
export function symbolHtml(symbol: string): string {
  const { qualifier, member } = shortSymbol(symbol);
  const title =
    qualifier.startsWith("…") || symbol.length > LONG_SYMBOL ? ` title="${escapeHtml(symbol)}"` : "";
  return `<code class="sym"${title}>${qualifier ? `<span class="cq">${breakable(escapeHtml(qualifier))}</span>` : ""}<span>${escapeHtml(
    member,
  )}</span></code>`;
}

/** A file reference (`path`, `path:12-20`, `path#Type.member`) as a link, or undefined for anything else. */
export function fileRefOf(text: string): string | undefined {
  const file = /\s/.test(text.trim()) ? null : FILE.exec(text.trim());
  return file
    ? fileRefHtml(
        file[1] as string,
        file[2] ? Number(file[2]) : undefined,
        file[3] ? Number(file[3]) : undefined,
        file[4],
      )
    : undefined;
}

/** A code span's content as markup: a file reference, a symbol, or code (long code wraps at its separators). */
export function codeSpanHtml(raw: string): string {
  const text = raw.trim();
  // a file ends with a known extension: `a/b` (a ratio, `and/or`) and `orders.created` are not files
  const file = fileRefOf(text);
  if (file) return file;
  // a symbol names a type (`OrderService.place`) or calls (`order.total()`); `orders.created` is a name
  if (SYMBOL.test(text) && /(^|[.#:])[A-Z]|#|::|\(\)$/.test(text)) return symbolHtml(text);
  const escaped = escapeHtml(raw);
  return `<code>${!/\s/.test(raw) && raw.length > 24 ? breakable(escaped) : escaped}</code>`;
}

/** Bare `File.java:12-20` in escaped prose → links (the text around stays as it is). */
export function linkBareFiles(escaped: string): string {
  return escaped.replace(BARE_FILE_LINE, (_m, before: string, path: string, line: string, end?: string) => {
    return `${before}${fileRefHtml(path, Number(line), end ? Number(end) : undefined)}`;
  });
}
