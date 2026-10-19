import type { ServicesView, ServiceView } from "../app/servicesView.ts";
import { isTerminal } from "../core/domain/run.ts";
import type { CatalogLink } from "../knowledge/catalog.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type Html, html, raw } from "./html.ts";
import { type KnowledgeCounts, knowledgeTabs } from "./knowledge.ts";
import type { Actions } from "./pages.ts";

/**
 * Knowledge → Services (ADR-0025): the map of a knowledge repository as a person checks it — what each
 * service is, which checks the agents run in it, what it serves and uses of the others — and a page
 * per service. What is missing is said where it is, with the one action that fills it: `jarvis
 * onboard` for commands, the editor for a description, `repos.<name>` for a repository elsewhere.
 */
export interface ServicesPage {
  readonly counts: KnowledgeCounts;
  readonly view: ServicesView;
  readonly homeDir: string;
  /** The knowledge repository's map as the page names it, relative to where `jarvis ui` runs. */
  readonly configPath: string;
  /** Where each service's architecture.md opens: its path relative to `jarvis ui`'s root. */
  readonly fileOf: (relToMeta: string) => string;
  /** Whether "Onboard" can run here (a launcher, a repository on this machine). */
  readonly canOnboard: boolean;
}

const home = (path: string, dir: string) =>
  dir && path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const serviceHref = (name: string) => `/knowledge/services?name=${encodeURIComponent(name)}`;

function form(actions: Actions, action: string, body: Html, attrs = ""): Html {
  return html`<form method="post" action="${action}"${raw(attrs)}><input type="hidden" name="t" value="${actions.token}">${body}</form>`;
}

function onboardButton(
  actions: Actions | undefined,
  names: readonly string[],
  label: string,
  back: string,
  cls = "btn small",
): Html {
  if (!actions || names.length === 0) return html``;
  return form(
    actions,
    "/knowledge/services/onboard",
    html`${names.map((n) => html`<input type="hidden" name="service" value="${n}">`)}<input type="hidden" name="back" value="${back}"><button type="submit" class="${cls}">${label}</button>`,
    ' style="display:inline"',
  );
}

function openButton(actions: Actions | undefined, file: string, back: string, label: string): Html {
  if (!actions) return html``;
  return form(
    actions,
    "/knowledge/open",
    html`<input type="hidden" name="file" value="${file}"><input type="hidden" name="back" value="${back}"><button type="submit" class="btn small">${label}</button>`,
    ' style="display:inline"',
  );
}

function kindPill(s: ServiceView): Html {
  if (s.kind) return html`<span class="pill ${s.kind === "frontend" ? "front" : "info"}">${s.kind}</span>`;
  return html`<span class="pill plain" title="set services.${s.name}.kind, or run jarvis onboard">kind ?</span>`;
}

/* ---- links between services ---- */

interface Pair {
  readonly from: string;
  readonly to: string;
  readonly kind: CatalogLink["kind"];
  readonly what: string[];
}

/** Links grouped: who calls whom (the caller first), who sends to whom by a topic. */
export function pairsOf(links: readonly CatalogLink[]): Pair[] {
  const by = new Map<string, Pair>();
  for (const l of links) {
    const [from, to] = l.kind === "http" ? [l.consumer, l.producer] : [l.producer, l.consumer];
    const key = `${l.kind}|${from}|${to}`;
    const p = by.get(key) ?? { from, to, kind: l.kind, what: [] };
    if (!p.what.includes(l.what)) p.what.push(l.what);
    by.set(key, p);
  }
  return [...by.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

const W = 156;
const H = 30;
const GAP_X = 20;
const GAP_Y = 64;

/**
 * The services as layers: a caller above what it calls, a sender above what reads it. Straight
 * lines, no crossings minimised — readable for the dozen services a map has; past that, the list.
 */
export function graphSvg(
  names: readonly string[],
  pairs: readonly Pair[],
  kinds: ReadonlyMap<string, string>,
): Html {
  if (names.length === 0 || names.length > 14 || pairs.length === 0) return html``;
  // layers by the calls only: a caller above what it calls (a cycle stops at the last layer); a
  // service with no calls either way goes under the services that send to it
  const layer = new Map(names.map((n) => [n, 0]));
  const calls = pairs.filter((p) => p.kind === "http");
  for (let i = 0; i < names.length; i++)
    for (const p of calls) {
      const next = (layer.get(p.from) ?? 0) + 1;
      if (next > (layer.get(p.to) ?? 0) && next < names.length) layer.set(p.to, next);
    }
  const calling = new Set(calls.flatMap((p) => [p.from, p.to]));
  for (const n of names) {
    if (calling.has(n)) continue;
    const senders = pairs.filter((p) => p.kind === "topic" && p.to === n && calling.has(p.from));
    if (senders.length > 0) layer.set(n, Math.max(...senders.map((p) => layer.get(p.from) ?? 0)) + 1);
  }
  const rows: string[][] = [];
  for (const n of names) {
    const l = layer.get(n) ?? 0;
    rows[l] = [...(rows[l] ?? []), n];
  }
  const dense = rows.filter((r) => r && r.length > 0);
  const widest = Math.max(...dense.map((r) => r.length));
  const width = widest * W + (widest - 1) * GAP_X;
  const height = dense.length * H + (dense.length - 1) * GAP_Y;
  const at = new Map<string, { x: number; y: number }>();
  dense.forEach((row, i) => {
    const span = row.length * W + (row.length - 1) * GAP_X;
    row.forEach((n, j) => {
      at.set(n, { x: (width - span) / 2 + j * (W + GAP_X), y: i * (H + GAP_Y) });
    });
  });
  const edges = pairs.map((p) => {
    const a = at.get(p.from);
    const b = at.get(p.to);
    if (!a || !b) return "";
    const down = b.y > a.y;
    const x1 = a.x + W / 2;
    const y1 = down ? a.y + H : a.y + H / 2;
    const x2 = b.x + W / 2;
    const y2 = down ? b.y : b.y + H / 2;
    const d = down
      ? `M${x1} ${y1} L${x2} ${y2 - 2}`
      : `M${x1 + (x2 > x1 ? W / 2 : -W / 2)} ${y1} C${x1} ${y1 - GAP_Y / 2} ${x2} ${y2 - GAP_Y / 2} ${x2 + (x2 > x1 ? -W / 2 : W / 2)} ${y2}`;
    return `<path d="${d}" class="sg-edge${p.kind === "topic" ? " topic" : ""}" marker-end="url(#sg-arrow)"><title>${esc(p.from)} ${p.kind === "http" ? "calls" : "sends to"} ${esc(p.to)}: ${esc(p.what.join(", "))}</title></path>`;
  });
  const nodes = names.map((n) => {
    const p = at.get(n) as { x: number; y: number };
    const label = n.length > 22 ? `${n.slice(0, 21)}…` : n;
    return `<a href="${serviceHref(n)}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" class="sg-node ${kinds.get(n) ?? "none"}"/><text x="${p.x + W / 2}" y="${p.y + H / 2 + 4}" text-anchor="middle">${esc(label)}<title>${esc(n)}</title></text></a>`;
  });
  const label = pairs.map((p) => `${p.from} ${p.kind === "http" ? "calls" : "sends to"} ${p.to}`).join("; ");
  return raw(
    `<svg class="sg" viewBox="-2 -2 ${width + 4} ${height + 4}" role="img" aria-label="${esc(label)}" style="max-width:${width + 4}px"><defs><marker id="sg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="sg-head"/></marker></defs>${edges.join("")}${nodes.join("")}</svg>`,
  );
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function talksTo(s: ServiceView): Html {
  const pairs = pairsOf(s.links);
  if (pairs.length === 0) return html`<span class="muted">—</span>`;
  const lines = pairs.slice(0, 4).map((p) => {
    const out = p.from === s.name;
    const other = out ? p.to : p.from;
    if (p.kind === "topic")
      return html`<div>${out ? "⇢" : "⇠"} <code>${p.what[0] ?? ""}</code>${p.what.length > 1 ? html` <span class="muted">+${p.what.length - 1}</span>` : ""} <span class="muted">${out ? "to" : "from"} ${other}</span></div>`;
    return html`<div>${out ? "→" : "←"} ${other} <span class="muted">${plural(p.what.length, "endpoint")}</span></div>`;
  });
  return html`${lines}${pairs.length > 4 ? html`<div class="muted">+${pairs.length - 4} more</div>` : ""}`;
}

function checksCell(s: ServiceView, page: ServicesPage, actions: Actions | undefined): Html {
  if (!s.present && s.tools.length === 0) return html`<span class="muted">—</span>`;
  const have = s.tools.filter((t) => ["tests", "typecheck", "lint"].includes(t.name));
  return html`${have.map((t) => html`<span class="sv-check" title="${t.command}${t.from === "shared" ? " (shared)" : ""}">✓ ${t.name}</span> `)}${
    s.missing.length > 0
      ? html`<div class="sv-miss">no ${s.missing.join(", ")}${page.canOnboard && s.present ? html` · ${onboardButton(actions, [s.name], "Onboard", "/knowledge/services", "linkbtn")}` : ""}</div>`
      : ""
  }`;
}

/** The map: a row per service, what is left to do above, the links beside. */
export function servicesContent(page: ServicesPage, actions?: Actions, notice?: Html): Html {
  const { view } = page;
  const todo = view.services.filter((s) => s.present && s.missing.length > 0).map((s) => s.name);
  const noAbout = view.services.filter((s) => !s.about).length;
  const absent = view.services.filter((s) => !s.present).length;
  const left = todo.length + noAbout + absent;
  const kinds = new Map(view.services.map((s) => [s.name, s.kind ?? "none"]));
  const pairs = pairsOf(view.links);
  return html`${knowledgeTabs("services", page.counts)}
${notice ?? ""}
${
  left > 0
    ? html`<div class="banner wait sv-todo" role="status"><span><b>${plural(left, "thing")} to finish</b> — ${[
        todo.length > 0 ? `${plural(todo.length, "service")} without commands for the checks` : "",
        noAbout > 0 ? `${plural(noAbout, "service")} without a description` : "",
        absent > 0 ? `${absent} not on this machine` : "",
      ]
        .filter(Boolean)
        .join(
          ", ",
        )}</span><span class="grow"></span>${page.canOnboard ? onboardButton(actions, todo, `Onboard ${plural(todo.length, "service")}`, "/knowledge/services", "btn small strong") : ""}</div>`
    : ""
}
<div class="cols">
<section class="panel mainc kdocs" aria-labelledby="svc-h">
<div class="row khead"><h2 id="svc-h">The map</h2><span class="hint">from <code>${page.configPath}</code> · services:</span><span class="grow"></span>${
    view.unmapped.length > 0
      ? html`<span class="hint">not in the map: ${view.unmapped.slice(0, 4).map((r, i) => html`${i > 0 ? ", " : ""}<code>${r.name}</code>`)}${view.unmapped.length > 4 ? ` +${view.unmapped.length - 4}` : ""} — add under services: if it is one</span>`
      : ""
  }</div>
<div class="ktable" role="table" aria-label="Services">
<div class="kr sv kh" role="row"><span role="columnheader">Service</span><span role="columnheader">What it is</span><span role="columnheader">Checks the agents run</span><span role="columnheader">Talks to</span></div>
${view.services.map(
  (s) =>
    html`<div class="kr sv${!s.present || !s.about || s.missing.length > 0 ? " warn" : ""}${s.name === view.current ? " current" : ""}" role="row">
<span role="cell" class="sv-name"><a href="${serviceHref(s.name)}"><b>${s.name}</b></a><span class="sv-sub">${kindPill(s)}${s.stack ? html` <span class="muted">${s.stack}</span>` : ""}</span>${s.present ? "" : html`<span class="pill bad">not on this machine</span>`}</span>
<span role="cell">${s.about ? html`<span class="sv-about">${s.about}</span>` : html`<span class="sv-miss">No description yet</span>`}<span class="sv-sub muted">${s.present ? "" : html`expected at <code>${home(s.repo, page.homeDir)}</code> · <code>repos.${s.name}</code> in the personal config · `}${plural(s.docs, "document")}${s.modules > 0 ? ` · ${plural(s.modules, "module")} described` : ""}</span></span>
<span role="cell">${checksCell(s, page, actions)}</span>
<span role="cell" class="sv-links">${talksTo(s)}</span>
</div>`,
)}
</div>
<p class="hint sv-legend">→ calls · ← is called by · ⇢ sends to a topic · ⇠ reads one. «What it is» is the first paragraph under the title of the service's <code>architecture.md</code>.</p>
</section>
<div class="side kside">
<section class="panel kbox" aria-labelledby="sg-h"><h2 id="sg-h">How they connect</h2>
${pairs.length === 0 ? html`<p class="hint">No links yet: <code>jarvis onboard</code> writes each service's contracts — what it serves, calls, sends and reads — and the links come from them.</p>` : ""}
${graphSvg(
  view.services.map((s) => s.name),
  pairs,
  kinds,
)}
${pairs.map(
  (p) =>
    html`<details class="sv-pair"><summary><b>${p.from} ${p.kind === "http" ? "→" : "⇢"} ${p.to}</b> <span class="muted">${p.kind === "http" ? plural(p.what.length, "endpoint") : plural(p.what.length, "topic")}</span></summary><ul>${p.what.map((w) => html`<li><code>${w}</code></li>`)}</ul></details>`,
)}
${pairs.length > 0 ? html`<p class="hint">From the contracts catalog. A task that names two linked services is offered as a task across services.</p>` : ""}
</section>
</div>
</div>`;
}

const STATE_DOT: Record<string, string> = { COMPLETED: "ok", FAILED: "bad", CANCELLED: "plain" };

/** One service: what it is, its commands, its contracts, the tasks in it. */
export function serviceContent(page: ServicesPage, s: ServiceView, actions?: Actions, notice?: Html): Html {
  const back = serviceHref(s.name);
  const c = s.contracts;
  const pairs = pairsOf(s.links);
  const usedBy = (what: string) =>
    s.links
      .filter((l) => l.kind === "http" && l.producer === s.name && l.what === what)
      .map((l) => l.consumer);
  const endpoint = (method: string | undefined, path: string, other: readonly string[]) =>
    html`<span class="sv-verb">${method ?? "ANY"}</span><span><code class="sv-path">${path}</code>${other.length > 0 ? html` <span class="muted">· ${other.join(", ")}</span>` : ""}</span>`;
  // a call links by where it is in the code: the catalog's link names the endpoint as its service serves it
  const callee = (e: { file: string; line?: number }) =>
    s.links.find(
      (l) =>
        l.kind === "http" &&
        l.consumer === s.name &&
        l.consumerAt === (e.line ? `${e.file}:${e.line}` : e.file),
    )?.producer;
  return html`${knowledgeTabs("services", page.counts)}
<nav class="hint" aria-label="Breadcrumb"><a href="/knowledge/services">Services</a> / ${s.name}</nav>
${notice ?? ""}
<div class="row sv-title"><h2 class="sv-h1">${s.name}</h2>${kindPill(s)}${s.stack ? html`<span class="muted">${s.stack}</span>` : ""}<code class="meta" title="${s.repo}">${home(s.repo, page.homeDir)}</code>${s.present ? "" : html`<span class="pill bad">not on this machine</span>`}<span class="grow"></span>
${s.hasArchitecture ? openButton(actions, page.fileOf(s.architecture), back, "Open the description") : ""}
${page.canOnboard && s.present ? onboardButton(actions, [s.name], s.missing.length > 0 || !s.hasArchitecture ? "Onboard" : "Onboard again", back) : ""}
${s.present ? html`<a class="btn small strong" href="/?repo=${encodeURIComponent(s.repo)}">New task here</a>` : ""}</div>
<div class="cols">
<div class="mainc">
<section class="panel kbox" aria-labelledby="about-h"><div class="row"><h2 id="about-h">What it is</h2><span class="grow"></span><code class="meta">${s.architecture}</code></div>
${
  s.about
    ? html`<p class="sv-lead">${s.about}</p>${s.more.map((p) => html`<p>${p}</p>`)}`
    : s.hasArchitecture
      ? html`<p class="sv-miss">No description yet: the architecture has only the facts <code>jarvis onboard</code> found. Write what ${s.name} is for in a paragraph under its title, and remove the <code>jarvis:onboard</code> marker line so <code>onboard --refresh</code> keeps it — the agents read it with every task here.</p>`
      : html`<p class="sv-miss">No architecture yet: <code>jarvis onboard</code> writes one from the code; then a paragraph under its title says what ${s.name} is for.</p>`
}
<p class="hint">${plural(s.docs, "document")} in <code>knowledge/services/${s.name}/</code>${s.modules > 0 ? ` · ${plural(s.modules, "module")} described` : ""}</p>
</section>
<section class="panel kbox" aria-labelledby="runs-h"><h2 id="runs-h">Recent tasks here</h2>
${
  s.runs.length === 0
    ? html`<p class="hint">None yet.</p>`
    : html`<ul class="sv-runs">${s.runs.map(
        (r) =>
          html`<li><span class="sv-dot ${STATE_DOT[r.state] ?? (isTerminal(r.state) ? "plain" : "info")}" aria-hidden="true"></span><a href="/runs/${encodeURIComponent(shortRunId(r.id))}">${r.task.split("\n")[0] ?? ""}</a> <span class="muted">${r.workflow} · ${r.state.toLowerCase().replace(/_/g, " ")}</span></li>`,
      )}</ul>`
}
</section>
</div>
<div class="side kside">
<section class="panel kbox" aria-labelledby="cmd-h"><h2 id="cmd-h">Checks the agents run</h2>
${
  s.tools.length === 0
    ? html`<p class="sv-miss">No commands: the agents change ${s.name} without running its tests.</p>`
    : html`<dl class="sv-kv">${s.tools.map((t) => html`<dt>${t.name}</dt><dd><code>${t.command}</code>${t.from === "shared" ? html` <span class="muted">shared</span>` : ""}</dd>`)}</dl>`
}
${s.missing.length > 0 && s.tools.length > 0 ? html`<p class="sv-miss">No ${s.missing.join(", ")}.</p>` : ""}
<p class="hint">From <code>services.${s.name}.tools.local</code> over the shared <code>tools.local</code> of <code>${page.configPath}</code>.</p>
</section>
<section class="panel kbox" aria-labelledby="ct-h"><h2 id="ct-h">Contracts</h2>
${
  !c
    ? html`<p class="hint">Not read yet: <code>jarvis onboard</code> writes <code>contracts.json</code> — what ${s.name} serves, calls, sends and reads.</p>`
    : html`${
        c.serves.length > 0
          ? html`<h3 class="sv-h3">Serves <span class="muted">${plural(c.serves.length, "endpoint")}</span></h3><div class="sv-ep">${c.serves.slice(0, 12).map((e) => endpoint(e.method, e.path, usedBy(`${e.method ? `${e.method} ` : ""}${e.path}`)))}</div>${c.serves.length > 12 ? html`<p class="hint">+${c.serves.length - 12} more in <code>knowledge/services/${s.name}/contracts.json</code></p>` : ""}`
          : ""
      }${
        c.calls.length > 0
          ? html`<h3 class="sv-h3">Calls</h3><div class="sv-ep">${c.calls.slice(0, 12).map((e) => {
              const to = callee(e);
              return endpoint(e.method, e.path, to ? [to] : [e.client ?? "?"]);
            })}</div>`
          : ""
      }${
        c.produces.length + c.consumes.length > 0
          ? html`<h3 class="sv-h3">Topics</h3><div class="sv-ep">${c.produces.map((t) =>
              endpoint(
                "SEND",
                t.topic,
                s.links
                  .filter((l) => l.kind === "topic" && l.producer === s.name && l.what === t.topic)
                  .map((l) => l.consumer),
              ),
            )}${c.consumes.map((t) =>
              endpoint(
                "READ",
                t.topic,
                s.links
                  .filter((l) => l.kind === "topic" && l.consumer === s.name && l.what === t.topic)
                  .map((l) => l.producer),
              ),
            )}</div>`
          : ""
      }${c.serves.length + c.calls.length + c.produces.length + c.consumes.length === 0 ? html`<p class="hint">None found in the code.</p>` : ""}`
}
${pairs.length > 0 ? html`<p class="hint">Linked with ${[...new Set(pairs.map((p) => (p.from === s.name ? p.to : p.from)))].map((n, i) => html`${i > 0 ? ", " : ""}<a href="${serviceHref(n)}">${n}</a>`)}</p>` : ""}
</section>
</div>
</div>`;
}
