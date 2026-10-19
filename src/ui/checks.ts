import type { Run } from "../core/domain/run.ts";
import { type Html, html, raw } from "./html.ts";
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
    ? `– ${r.check} · skipped`
    : r.ok
      ? `✓ ${r.check}`
      : r.tests
        ? `✕ ${r.check} · ${r.tests.failed}${r.tests.total ? ` of ${r.tests.total}` : ""} failed`
        : `✕ ${r.check}`;
  return html`<a href="#check-${r.check}" class="pill ${r.skipped ? "plain" : r.ok ? "ok" : "bad"}" title="${r.command}${r.skipped ? ` — ${r.skipped}` : ""}">${label}</a>`;
}

function failureHtml(f: Failure): Html {
  const frames = f.stack ?? [];
  const title = f.name.replace(/\(\)$/, "");
  return html`<article class="tf">
<div class="tf-head"><h3>${title}</h3>${f.suite ? html`<code class="meta">${f.suite}</code>` : ""}<span class="grow"></span>${f.preexisting ? html`<span class="pill plain" title="fails on the base commit too">also on the base</span>` : ""}</div>
<dl class="tf-facts">
<dt>Failure</dt><dd><pre>${f.message}</pre></dd>
${f.expected !== undefined && f.actual !== undefined ? html`<dt>Expected</dt><dd><code class="ok">${f.expected}</code></dd><dt>Got</dt><dd><code class="bad">${f.actual}</code></dd>` : ""}
${
  frames.length > 0
    ? html`<dt>Where</dt><dd><ul class="tf-frames">${frames.map(
        (s) =>
          html`<li>${raw(fileRefHtml(s.file, s.line))}${s.fn ? html` <span class="meta">${s.fn}</span>` : ""}${s.changed ? html` <span class="pill wait">changed by this run</span>` : ""}</li>`,
      )}</ul>${f.hidden ? html`<span class="hint">${f.hidden} frame${f.hidden === 1 ? "" : "s"} of the runner and libraries not shown</span>` : ""}</dd>`
    : f.file
      ? html`<dt>File</dt><dd>${raw(fileRefHtml(f.file))}</dd>`
      : ""
}
</dl>
</article>`;
}

function resultHtml(run: Pick<Run, "id">, r: Result): Html {
  const log = logHref(run, r);
  const failures = r.failures ?? [];
  return html`<section class="panel tf-check" id="check-${r.check}" aria-labelledby="check-${r.check}-h">
<div class="row"><h2 id="check-${r.check}-h">${r.check}</h2><span class="pill bad">${r.tests ? `${r.tests.failed}${r.tests.total ? ` of ${r.tests.total}` : ""} tests failed` : "failed"}</span><code class="meta">${r.command}</code></div>
${failures.map(failureHtml)}
${failures.length === 0 && r.tail ? html`<pre class="tf-tail">${r.tail}</pre>` : ""}
${r.failures && r.tests && r.tests.failed > failures.length ? html`<p class="hint">${r.tests.failed - failures.length} more failed tests are in the full output.</p>` : ""}
${log ? html`<p><a href="${log}">The whole output</a> <span class="hint">— what the command printed, every line</span></p>` : ""}
</section>`;
}

/** The checks artifact's body. */
export function checksHtml(run: Pick<Run, "id">, results: readonly Result[]): Html {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const tests = failed.reduce((n, r) => n + (r.tests?.failed ?? 0), 0);
  const lead =
    failed.length === 0
      ? "Every check passed."
      : tests > 0
        ? `${tests} test${tests === 1 ? "" : "s"} failed${failed.length > 1 ? `, ${failed.length} checks in all` : ""}. The implementation goes back with these failures as its reasons.`
        : `${failed.length} check${failed.length === 1 ? "" : "s"} failed. The implementation goes back with their output as its reasons.`;
  return html`<div class="tf-all">
<p>${lead}</p>
<div class="row" style="flex-wrap:wrap;gap:8px">${results.map(chip)}</div>
${failed.map((r) => resultHtml(run, r))}
</div>`;
}
