/**
 * Figma node ids as a person knows them: by the title of the frame or the name of the screen the
 * design document gives them (src/design/collect.ts, src/design/figma.ts). Pilot: a spec asked
 * «which variant of frame 100:1 is the target» — a number nobody at the gate could place.
 */
export interface FrameName {
  readonly name: string;
  readonly link?: string;
}

const withNode = (link: string, id: string) =>
  /[?&]node-id=/.test(link) ? link.replace(/([?&]node-id=)[^&#]+/, `$1${id.replace(":", "-")}`) : link;

/** Node id (`100:1`) → its name and link, from the run's design document. */
export function frameNamesOf(design: string | undefined): Map<string, FrameName> {
  const out = new Map<string, FrameName>();
  if (!design) return out;
  let title: string | undefined;
  let link: string | undefined;
  for (const line of design.split("\n")) {
    const frame = /^## \d+\. (.+)$/.exec(line);
    if (frame) {
      title = (frame[1] as string).trim();
      link = undefined;
      continue;
    }
    const figma = /^Figma: .* · node (\d+:\d+)(?: · (https?:\/\/\S+))?/.exec(line);
    if (figma && title) {
      link = figma[2];
      out.set(figma[1] as string, { name: title, ...(link ? { link } : {}) });
      continue;
    }
    const screen = /^#### (.+?) · node (\d+:\d+)$/.exec(line);
    if (screen) {
      const id = screen[2] as string;
      out.set(id, { name: (screen[1] as string).trim(), ...(link ? { link: withNode(link, id) } : {}) });
    }
  }
  return out;
}

const NODE_ID = /(?<![\w=/.-])(\d+)[:-](\d+)(?![\w:-])/g;

/** The node ids the names know, put as «name» (a link's `node-id=` is left alone). */
export function humanizeNodeIds(text: string, names: ReadonlyMap<string, FrameName>): string {
  if (names.size === 0) return text;
  return text.replace(NODE_ID, (m, a: string, b: string) => {
    const f = names.get(`${a}:${b}`);
    return f ? `«${f.name}»` : m;
  });
}

/** A source naming a known node: the name for a person and the link to open it. */
export function humanizeSource(
  source: string,
  names: ReadonlyMap<string, FrameName>,
): { text: string; link?: string } {
  let link: string | undefined;
  for (const m of source.matchAll(NODE_ID)) link ??= names.get(`${m[1]}:${m[2]}`)?.link;
  const text = humanizeNodeIds(source, names)
    .replace(/^(?:frame|node|фрейм|узел)\s+(?=«)/i, "frame ")
    .trim();
  return { text, ...(link ? { link } : {}) };
}
