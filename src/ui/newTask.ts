import { basename } from "node:path";
import type { CatalogLink, NamedService } from "../knowledge/catalog.ts";
import { type Html, html } from "./html.ts";
import type { Actions, LaunchView } from "./pages.ts";

/**
 * "New task" on the Runs page: one box for the task with two controls under it — Where (a button that
 * opens the list of places: all services, one service, other repositories) and How far (the same four
 * everywhere; what cannot run in the place is disabled with why, not hidden) — and a button named after
 * the action and the place. A plain form underneath: radios for both, so it works without the script.
 */

/** A place a task can run in. */
export interface StartPlace {
  readonly root: string;
  readonly name: string;
  /** The knowledge repository: a task there is across its services. */
  readonly across?: boolean;
  /** A service's kind from the map: backend, frontend, library. */
  readonly kind?: string;
  /** The knowledge repository: how many services its map has. */
  readonly services?: number;
  readonly group: "across" | "service" | "other";
}

export interface StartForm {
  readonly places: readonly StartPlace[];
  readonly current?: string;
  readonly launches: readonly LaunchView[];
  readonly homeDir: string;
  readonly notice?: Html;
}

/** How far a task goes: the same four in every place. */
export type HowFar = "research" | "fix" | "sdd" | "spec";

interface HowFarDef {
  readonly id: HowFar;
  readonly label: string;
  /** In one service or repository: `<verb> in <name>`, and what it does. */
  readonly one: { readonly verb: string; readonly what: string };
  /** Across services; none when it runs in one service only. */
  readonly across?: { readonly go: string; readonly what: string };
}

export const HOW_FAR: readonly HowFarDef[] = [
  {
    id: "research",
    label: "Research",
    one: { verb: "Research", what: "find out what the task touches and what is unknown; nothing changes" },
    across: {
      go: "Research across services",
      what: "which services the task touches and what each needs; nothing changes",
    },
  },
  {
    id: "fix",
    label: "Fix a bug",
    one: { verb: "Fix", what: "research, a spec to approve, the fix, checks, review" },
  },
  {
    id: "sdd",
    label: "Implement",
    one: { verb: "Implement", what: "requirements, a spec to approve, impact, plan, code, checks, review" },
    across: {
      go: "Implement across services",
      what: "one spec, a subtask per service, the contract between them, delivery in order",
    },
  },
  {
    id: "spec",
    label: "Spec only",
    one: { verb: "Write the spec", what: "up to an approved spec; implement later" },
    across: { go: "Spec across services", what: "one spec for all the services, approved; split later" },
  },
];

export const ONE_SERVICE_ONLY = "In one service only — pick it in Where";

/**
 * The workflow a choice runs: Implement in the knowledge repository is the task across services;
 * research and spec there turn across services by themselves (src/app/subtasks.ts). Fix there is none.
 */
export function workflowOfChoice(how: string, across: boolean): string | undefined {
  if (across && how === "fix") return undefined;
  if (across && how === "sdd") return "sdd-cross";
  return how;
}

/** The places in the order of the list: all services, the services of the map, other repositories. */
export function placesOf(input: {
  readonly repos: readonly string[];
  readonly meta?: {
    readonly root: string;
    readonly repos: Readonly<Record<string, string>>;
    readonly kinds: Readonly<Record<string, string>>;
  };
}): StartPlace[] {
  const { meta } = input;
  const known = new Set(input.repos);
  const services = meta
    ? Object.entries(meta.repos)
        .filter(([, root]) => known.has(root))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  const taken = new Set([...(meta ? [meta.root] : []), ...services.map(([, root]) => root)]);
  return [
    ...(meta
      ? [
          {
            root: meta.root,
            name: "All services",
            across: true,
            services: Object.keys(meta.repos).length,
            group: "across" as const,
          },
        ]
      : []),
    ...services.map(([name, root]) => {
      const kind = meta?.kinds[name];
      return { root, name, ...(kind ? { kind } : {}), group: "service" as const };
    }),
    ...input.repos
      .filter((r) => !taken.has(r))
      .map((root) => ({ root, name: basename(root) || root, group: "other" as const })),
  ];
}

const home = (path: string, dir: string) =>
  dir && path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const goOf = (h: HowFarDef, place: StartPlace | undefined) =>
  place?.across && h.across ? h.across.go : `${h.one.verb} in ${place?.name ?? "this repository"}`;
const whatOf = (h: HowFarDef, place: StartPlace | undefined) =>
  place?.across && h.across
    ? html`<b>${h.label}</b> across services — ${h.across.what}.`
    : html`<b>${h.label}</b> — ${h.one.what}.`;

function iconOf(place: StartPlace): Html {
  return place.across
    ? html`<span class="ic all" aria-hidden="true">◎</span>`
    : html`<span class="ic" aria-hidden="true">${(place.name[0] ?? "?").toUpperCase()}</span>`;
}

function badgeOf(place: StartPlace): Html | string {
  if (place.across) return html`<span class="badge">knowledge repo</span>`;
  if (!place.kind) return "";
  return html`<span class="badge${place.kind === "library" ? " lib" : ""}">${place.kind}</span>`;
}

const GROUPS: ReadonlyArray<[StartPlace["group"], string]> = [
  ["across", "Across services"],
  ["service", "One service"],
  ["other", "Other repositories with runs"],
];

function whereHtml(places: readonly StartPlace[], chosen: StartPlace | undefined, homeDir: string): Html {
  const label = (p: StartPlace | undefined) =>
    p ? html`${iconOf(p)}<span data-where-name>${p.name}</span>${badgeOf(p)}` : html`<span>—</span>`;
  if (places.length < 2)
    return html`<input type="hidden" name="repo" value="${chosen?.root ?? ""}"><span class="pick still" title="${home(chosen?.root ?? "", homeDir)}">${label(chosen)}</span>`;
  const groups = GROUPS.map(([g, title]) => [title, places.filter((p) => p.group === g)] as const).filter(
    ([, ps]) => ps.length > 0,
  );
  const option = (p: StartPlace) =>
    html`<label class="opt" data-find="${`${p.name} ${p.root}`.toLowerCase()}"><input type="radio" name="repo" value="${p.root}" data-name="${p.name}"${p.across ? " data-across" : ""}${p === chosen ? " checked" : ""}><span class="ck" aria-hidden="true">✓</span><span class="nm">${p.name}</span>${badgeOf(p)}<span class="p">${home(p.root, homeDir)}${p.services !== undefined ? ` · ${plural(p.services, "service")}` : ""}</span></label>`;
  return html`<details class="where" data-where>
<summary class="pick" title="Where it runs" aria-label="Where it runs">${label(chosen)}<span class="car" aria-hidden="true">▾</span></summary>
<div class="pop" role="group" aria-label="Where it runs">
${places.length > 6 ? html`<input type="search" class="find" data-where-find placeholder="Find a service or repository" aria-label="Find a service or repository">` : ""}
${groups.map(([title, ps]) => html`<div class="grp">${title}</div>${ps.map(option)}`)}
<p class="none" data-where-none hidden>Nothing found</p>
</div>
</details>`;
}

function howFarHtml(chosen: StartPlace | undefined, on: HowFar): Html {
  return html`<div class="seg" role="radiogroup" aria-label="How far">${HOW_FAR.map((h) => {
    const off = chosen?.across === true && !h.across;
    return html`<label${off ? html` title="${ONE_SERVICE_ONLY}"` : ""}><input type="radio" name="workflow" value="${h.id}" data-label="${h.label}" data-verb="${h.one.verb}" data-what="${h.one.what}"${h.across ? html` data-across-go="${h.across.go}" data-across-what="${h.across.what}"` : " data-one-only"}${h.id === on ? " checked" : ""}${off ? " disabled" : ""}><span>${h.label}</span></label>`;
  })}</div>`;
}

/** The form; research first and chosen in every place: find out before changing anything. */
export function newTaskHtml(start: StartForm, actions: Actions): Html {
  const chosen = start.places.find((p) => p.root === start.current) ?? start.places[0];
  const on: HowFar = "research";
  const h = HOW_FAR.find((x) => x.id === on) as HowFarDef;
  return html`<section class="panel newtask" aria-labelledby="new-title" id="new">
<form method="post" action="/runs/new" data-newtask><input type="hidden" name="t" value="${actions.token}">
<h2 id="new-title">New task</h2>
<div class="composer">
<textarea name="task" rows="3" required maxlength="4000" aria-label="What to do" placeholder="ABC-123 — or in words: what to find out, the bug, the change"></textarea>
<div class="cbar">${whereHtml(start.places, chosen, start.homeDir)}${howFarHtml(chosen, on)}<span class="grow"></span><button type="submit" class="btn primary" data-go>${goOf(h, chosen)}</button></div>
</div>
<p class="what" data-said aria-live="polite">${whatOf(h, chosen)}</p>
<div class="startfrom" data-from aria-live="polite"></div>
<details class="more"><summary>More options</summary>
<label class="check"><input type="checkbox" name="fresh" value="design"> Read the Figma frames again <span class="meta">— the design changed at the same link; past Jarvis's one-day cache, each frame is a Figma API call</span></label>
</details>
<p class="hint">Runs in the background, as <code>jarvis research "…"</code> (or the one chosen) would without a terminal; where it needs you, it waits here — decide on the page and it goes on.</p>
</form>
</section>`;
}

/**
 * Under "New task" in one service: the task names services the contract catalog links (ADR-0025 §7)
 * — a note with a link that changes only Where; nothing switches by itself.
 */
export function crossNoteHtml(named: readonly NamedService[], link: CatalogLink, metaRoot: string): Html {
  const names = named.map((n) => n.service);
  return html`<div class="cnote"><span aria-hidden="true">ⓘ</span><span>The task names ${names.map((n, i) => html`${i === 0 ? "" : i === names.length - 1 ? " and " : ", "}<b>${n}</b>`)}, linked by <code>${link.what}</code>. If ${names.length === 2 ? "both" : "they"} must change, run it in <button type="button" class="linkish" data-cross data-repo="${metaRoot}">All services</button>.</span></div>`;
}
