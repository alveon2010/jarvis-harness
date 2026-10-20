import type { Run } from "../core/domain/run.ts";
import { brokeLine, excerptOf } from "../orchestration/tools/excerpt.ts";
import { type Html, html, raw } from "./html.ts";
import { plural, t } from "./i18n.ts";
import { fileRefHtml } from "./refs.ts";

/**
 * The checks of a run as a person reads them (src/orchestration/tools/builtin.ts, `project.checks`):
 * each check passed or failed, and for failed tests each test — what was expected and what came,
 * where in the project, the line the run changed marked — with the whole output a click away.
 * Pilot: a failed check showed its last 40 lines, often the runner's summary and not the failure.
 */
interface Frame {
  readonly file: string;
  readonly line?: number;
  readonly fn?: string;
  readonly changed?: boolean;
}

interface Failure {
  readonly suite?: string;
  readonly name: string;
  readonly file?: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly stack?: readonly Frame[];
  readonly hidden?: number;
  readonly preexisting?: boolean;
}

interface Result {
  readonly check: string;
  readonly command: string;
  readonly ok: boolean;
  readonly skipped?: string;
  readonly tail?: string;
  readonly log?: string;
  readonly failures?: readonly Failure[];
  readonly tests?: { readonly failed: number; readonly total?: number };
  readonly preexisting?: readonly string[];
  readonly fixed?: readonly string[];
}

/** The checks document, if `doc` is one. */
export function checksOf(doc: unknown): readonly Result[] | undefined {
  const results = (doc as { results?: unknown } | undefined)?.results;
  return Array.isArray(results) && results.every((r) => typeof (r as Result)?.check === "string")
    ? (results as Result[])
    : undefined;
}

const logHref = (run: Pick<Run, "id">, r: Result): string | undefined => {
  const version = Number(r.log?.split("@")[1]);
  if (!r.log || !Number.isFinite(version)) return undefined;
  const name = `${r.check.replace(/[^\w.-]+/g, "-")}.log`;
  return `/runs/${encodeURIComponent(run.id.slice(4, 12))}/artifacts/check-log/${encodeURIComponent(name)}?v=${version}`;
};

function chip(r: Result): Html {
  const label = r.skipped
    ? `– ${r.check} · ${t("skipped")}`
    : r.ok
      ? `✓ ${r.check}`
      : r.tests
        ? `✕ ${r.check} · ${r.tests.total ? t("{n} of {m} failed", { n: r.tests.failed, m: r.tests.total }) : t("{n} failed", { n: r.tests.failed })}`
        : `✕ ${r.check}`;
  return html`<a href="#check-${r.check}" class="pill ${r.skipped ? "plain" : r.ok ? "ok" : "bad"}" title="${r.command}${r.skipped ? ` — ${r.skipped}` : ""}">${label}</a>`;
}

function failureHtml(f: Failure): Html {
  const frames = f.stack ?? [];
  const title = f.name.replace(/\(\)$/, "");
  return html`<article class="tf">
<div class="tf-head"><h3>${title}</h3>${f.suite ? html`<code class="meta">${f.suite}</code>` : ""}<span class="grow"></span>${f.preexisting ? html`<span class="pill plain" title="${t("fails on the base commit too")}">${t("also on the base")}</span>` : ""}</div>
<dl class="tf-facts">
<dt>${t("Failure")}</dt><dd><pre>${f.message}</pre></dd>
${f.expected !== undefined && f.actual !== undefined ? html`<dt>${t("Expected")}</dt><dd><code class="ok">${f.expected}</code></dd><dt>${t("Got")}</dt><dd><code class="bad">${f.actual}</code></dd>` : ""}
${
  frames.length > 0
    ? html`<dt>${t("Where")}</dt><dd><ul class="tf-frames">${frames.map(
        (s) =>
          html`<li>${raw(fileRefHtml(s.file, s.line))}${s.fn ? html` <span class="meta">${s.fn}</span>` : ""}${s.changed ? html` <span class="pill wait">${t("changed by this run")}</span>` : ""}</li>`,
      )}</ul>${f.hidden ? html`<span class="hint">${t("{n} of the runner and libraries not shown", { n: plural(f.hidden, "frame") })}</span>` : ""}</dd>`
    : f.file
      ? html`<dt>${t("File")}</dt><dd>${raw(fileRefHtml(f.file))}</dd>`
      : ""
}
</dl>
</article>`;
}

function resultHtml(run: Pick<Run, "id">, r: Result): Html {
  const log = logHref(run, r);
  const failures = r.failures ?? [];
  return html`<section class="panel tf-check" id="check-${r.check}" aria-labelledby="check-${r.check}-h">
<div class="row"><h2 id="check-${r.check}-h">${r.check}</h2><span class="pill bad">${r.tests ? (r.tests.total ? t("{n} of {m} tests failed", { n: r.tests.failed, m: r.tests.total }) : t("{n} tests failed", { n: r.tests.failed })) : t("failed")}</span><code class="meta">${r.command}</code></div>
${failures.map(failureHtml)}
${failures.length === 0 && r.tail ? html`<pre class="tf-tail">${r.tail}</pre>` : ""}
${r.failures && r.tests && r.tests.failed > failures.length ? html`<p class="hint">${t("{n} more failed tests are in the full output.", { n: r.tests.failed - failures.length })}</p>` : ""}
${log ? html`<p><a href="${log}">${t("The whole output")}</a> <span class="hint">${t("— what the command printed, every line")}</span></p>` : ""}
</section>`;
}

/** The checks artifact's body. */
export function checksHtml(run: Pick<Run, "id">, results: readonly Result[]): Html {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const tests = failed.reduce((n, r) => n + (r.tests?.failed ?? 0), 0);
  const lead =
    failed.length === 0
      ? t("Every check passed.")
      : tests > 0
        ? `${t("{n} failed", { n: plural(tests, "test") })}${failed.length > 1 ? `, ${t("{n} in all", { n: plural(failed.length, "check") })}` : ""}. ${t("The implementation goes back with these failures as its reasons.")}`
        : `${t("{n} failed", { n: plural(failed.length, "check") })}. ${t("The implementation goes back with their output as its reasons.")}`;
  return html`<div class="tf-all">
<p>${lead}</p>
<div class="row" style="flex-wrap:wrap;gap:8px">${results.map(chip)}</div>
${failed.map((r) => resultHtml(run, r))}
</div>`;
}

/**
 * A check's whole output (the `check-log` artifact) as a person reads it: the lines that say what
 * broke and the end kept, marked; the rest folded where it was, a click away — the same lines the
 * agent got when the runner wrote no report (src/orchestration/tools/excerpt.ts).
 */
export function checkLogHtml(text: string): Html {
  const ex = excerptOf(text);
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const show = (ls: readonly string[]) =>
    ls.map((l) => (brokeLine(l) ? html`<mark>${l}</mark>\n` : html`${l}\n`));
  return html`<div class="tf-log">
<div class="row" style="flex-wrap:wrap;gap:8px 14px"><span class="meta">${plural(ex.total, "line")} · ${t("{n} say what broke, marked · the rest folded", { n: ex.hits })}</span><span class="grow"></span><button type="button" class="btn small" data-unfold>${t("Show every line")}</button><button type="button" class="btn small" data-copy="${text.length <= 2_000_000 ? text : text.slice(-2_000_000)}">${t("Copy all")}</button></div>
<pre class="log">${ex.parts.map((p) =>
    p.kind === "lines"
      ? show(p.lines)
      : html`<details class="fold"><summary>… ${t("{n} ({from}–{to}) — show", { n: plural(p.count, "line"), from: p.from + 1, to: p.from + p.count })}</summary>${show(lines.slice(p.from, p.from + p.count))}</details>`,
  )}</pre>
</div>`;
}
