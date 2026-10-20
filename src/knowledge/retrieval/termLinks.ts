import type { GlossaryEntry } from "./glossary.ts";

/**
 * Glossary from runs (ADR-0015 §3): research and impact record which business terms of the task led
 * to which code symbols (`termLinks[]`). After the run these links become glossary proposals for a
 * person to accept — deterministic, no model call. A human version of an artifact outranks the
 * agent's: when a person edited the links of a term, only theirs count for it.
 */
export interface TermLink {
  readonly term: string;
  readonly symbols: readonly string[];
  readonly sources?: readonly string[];
}

/** One artifact's links: its ref (`artifactId@v`) and whether a person wrote that version. */
export interface LinkedArtifact {
  readonly ref: string;
  readonly human: boolean;
  readonly termLinks: readonly TermLink[];
}

export interface GlossaryProposal {
  /** The term as the glossary has it when it is there, else as the run said it. */
  readonly term: string;
  /** Symbols the glossary does not have for the term yet. */
  readonly symbols: string[];
  readonly sources: string[];
  /** Artifacts the links came from. */
  readonly from: string[];
  /** The glossary has the term: the proposal adds symbols to its row. */
  readonly existing: boolean;
}

const clean = (s: string) => s.trim().replace(/^`|`$/g, "").trim();
const strs = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map(clean)
        .filter(Boolean)
    : [];

/** `termLinks` of an artifact's JSON; none for anything else. */
export function termLinksIn(text: string): TermLink[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const links = (doc as { termLinks?: unknown } | null)?.termLinks;
  if (!Array.isArray(links)) return [];
  const out: TermLink[] = [];
  for (const l of links) {
    const term = typeof l?.term === "string" ? l.term.trim() : "";
    const symbols = strs(l?.symbols);
    if (term && symbols.length > 0) out.push({ term, symbols, sources: strs(l?.sources) });
  }
  return out;
}

function entryOf(term: string, glossary: readonly GlossaryEntry[]): GlossaryEntry | undefined {
  const t = term.toLowerCase();
  return (
    glossary.find((e) => e.term.toLowerCase() === t) ??
    glossary.find((e) => e.synonyms.some((s) => s.toLowerCase() === t))
  );
}

/** What the run linked that the glossary lacks, one proposal per term, sorted by term. */
export function proposeGlossary(
  artifacts: readonly LinkedArtifact[],
  glossary: readonly GlossaryEntry[],
): GlossaryProposal[] {
  const byTerm = new Map<string, Array<{ link: TermLink; ref: string; human: boolean }>>();
  for (const a of artifacts)
    for (const link of a.termLinks) {
      const key = link.term.toLowerCase();
      byTerm.set(key, [...(byTerm.get(key) ?? []), { link, ref: a.ref, human: a.human }]);
    }
  const out: GlossaryProposal[] = [];
  for (const links of byTerm.values()) {
    const human = links.filter((l) => l.human);
    const taken = human.length > 0 ? human : links;
    const first = taken[0] as (typeof taken)[number];
    const entry = entryOf(first.link.term, glossary);
    const known = new Set((entry?.symbols ?? []).map((s) => clean(s)));
    const symbols = [...new Set(taken.flatMap((l) => l.link.symbols.map(clean)))].filter(
      (s) => s && !known.has(s),
    );
    if (symbols.length === 0) continue;
    out.push({
      term: entry?.term ?? first.link.term,
      symbols,
      sources: [...new Set(taken.flatMap((l) => l.link.sources ?? []))].sort(),
      from: [...new Set(taken.map((l) => l.ref))],
      existing: entry !== undefined,
    });
  }
  return out.sort((a, b) => a.term.localeCompare(b.term));
}
