import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join as joinPath, relative, resolve as resolvePath, sep } from "node:path";
import { applyRun } from "../app/applyRun.ts";
import { budgetGranted, budgetStopOf, grantBudget } from "../app/budgetStop.ts";
import {
  type Candidate,
  CandidateTargetTaken,
  candidatesOf,
  contentOf,
  existingAt,
  promoteCandidate,
  rejectCandidate,
  targetOf,
} from "../app/candidates.ts";
import { continuationOf, startPointOf } from "../app/continuation.ts";
import {
  awaitedArtifact,
  DecisionTakenError,
  parkedAt,
  recordDecision,
  requestRerun,
  rerunRequested,
  waitingCard,
} from "../app/decide.ts";
import { continuedBy } from "../app/handoff.ts";
import {
  addGlossaryTerm,
  checkSymbols,
  docsOf,
  GlossaryTermTaken,
  type GlossaryView,
  glossaryOf,
  skillsOf,
  standardsOf,
  usageOf,
} from "../app/knowledgeView.ts";
import { type McpProbe, mcpHealthOf } from "../app/mcpHealth.ts";
import { modelsHealthOf } from "../app/modelHealth.ts";
import { pauseRequested, requestPause } from "../app/pause.ts";
import { resumableOf } from "../app/resumable.ts";
import type { Runtime } from "../app/runtime.ts";
import { isDone, resumeMaster, startSubtask, subtasksOf } from "../app/subtasks.ts";
import { tryOutOf } from "../app/tryOut.ts";
import { type OpenChecked, type OpenIn, type OpenResult, reviewFiles } from "../cli/checkout.ts";
import { humanMove } from "../cli/commands/human.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import { layoutOf, rootRelative } from "../core/paths.ts";
import { caseOfRun, runToCase } from "../evals/runToCase.ts";
import {
  answersText,
  givenFromForm,
  openQuestionsOf,
  prepareSuggestions,
  recordGiven,
  suggestionsFor,
} from "../interaction/answers.ts";
import { earlierRulesFor } from "../interaction/clarify.ts";
import { addNote } from "../interaction/notes.ts";
import { answerFromKnowledge, plan } from "../knowledge/ask.ts";
import { loadKnowledgeDocs } from "../knowledge/resolver.ts";
import { loadGlossary } from "../knowledge/retrieval/glossary.ts";
import type { RetrievalResult } from "../knowledge/retrieval/retriever.ts";
import { refreshIndex, search } from "../knowledge/retrieval/service.ts";
import { loadSkills } from "../knowledge/skills.ts";
import { knowledgeRootsOf } from "../knowledge/sources.ts";
import { loadStandards } from "../knowledge/standards.ts";
import { NOTE_MAX } from "../onboarding/deep.ts";
import { findNode, type ModuleTree, moduleTree } from "../onboarding/tree.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { deleteBranchKeepingTip, WorktreeError, WorktreeWorkspace } from "../orchestration/worktree.ts";
import { egressNotices } from "../security/policy/egress.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { type AskView, askContent, askOfRun, recentAsks } from "./ask.ts";
import { SCRIPT, STYLE } from "./assets.ts";
import { type DiffFile, type Html, html, parseDiff } from "./html.ts";
import {
  ARCHITECTURE,
  docsContent,
  glossaryContent,
  type KnowledgeCounts,
  knowledgeTabs,
  overviewContent,
  skillsContent,
  standardsContent,
} from "./knowledge.ts";
import { type Launch, type Launcher, WORKFLOWS, type Workflow } from "./launcher.ts";
import { artifactPage, runPage, runsPage } from "./model.ts";
import {
  candidateReviewHtml,
  type Draft,
  draftsHtml,
  type ModulesPage,
  modulesContent,
  researchFirst,
  researchOf,
} from "./modules.ts";
import {
  type Actions,
  type ArtifactExtras,
  artifactContent,
  type Chrome,
  errorContent,
  forbiddenPage,
  launchContent,
  layout,
  mcpPending,
  mcpPopover,
  mcpSummary,
  modelsBadge,
  modelsPending,
  modelsPopover,
  modelsSummary,
  repoPicker,
  runContent,
  runsContent,
  startFromHtml,
} from "./pages.ts";

/**
 * `jarvis ui` (ADR-0023 §3, §5): a local page over the journal. `node:http`, no framework; only
 * 127.0.0.1; a random session token in the address, required on every request (a cookie after the
 * first one); live updates by Server-Sent Events from the tail of `events`, polled once a second as
 * `jarvis follow` does. The server never runs a workflow and never holds a lease: it reads, and —
 * with actions — records decisions through the same functions as the terminal.
 */
export interface UiServerOptions {
  readonly runtime: Runtime;
  readonly engine: LocalWorkflowEngine;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly token?: string;
  readonly homeDir: string;
  /** The repository `jarvis ui` was started in: its runs are shown first. */
  readonly projectRoot?: string;
  /** The actor of decisions made on the page (the CLI's, ADR-0006). */
  readonly actor?: () => Promise<Actor | undefined>;
  /** How often the journal is looked at for live updates (ms). */
  readonly pollMs?: number;
  /** "Open in editor": the run's checkout in the person's editor (the card's `o`). */
  readonly open?: OpenIn;
  /** A file a page refers to in the editor, saying whether it opened (`/open`); else `open`. */
  readonly openChecked?: OpenChecked;
  /** Pages only: no forms, no POST. */
  readonly readOnly?: boolean;
  /** Starts runs from the page and drives them (src/ui/launcher.ts); none — no "New task". */
  readonly launcher?: Launcher;
  /** How often each MCP server is checked for an answer (ms); 0 — only on "Check now". */
  readonly mcpCheckEveryMs?: number;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

/** What a waiting run needs from a person, for a system notification's title. */
export function waitingWhat(run: Run): string {
  const step = run.currentStep ?? "a step";
  const w = run.waitingFor;
  switch (w?.kind) {
    case "approval":
      return `approve the ${w.detail ?? "document"}`;
    case "clarification":
      return "answer the agent's questions";
    case "loop":
      return `${step} sent the work back too often`;
    case "budget":
      return `${step} stopped on a budget`;
    case "effect":
      return "check an external effect";
    case "review":
      return "review the change";
    case "conflict":
      return "resolve a conflict";
    default:
      return "a decision";
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // same-origin: no referrer for the fonts, and a form post keeps its Origin (no-referrer makes it "null")
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** The context of one request: the page's address, how to answer. */
interface Request {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runtime, engine } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  let port = options.port ?? 0;
  const cookie = () => `jarvis_ui_${port}`;
  const address = () => `127.0.0.1:${port}`;

  /* ---- live updates: one poller over the journal, fanned out to every open page ---- */
  const clients = new Set<ServerResponse>();
  let seq = runtime.events.lastSeq();
  let poller: ReturnType<typeof setInterval> | undefined;
  let beat = 0;
  const poll = () => {
    try {
      const batch = runtime.events.list({ afterSeq: seq, limit: 5000 });
      if (batch.length > 0) {
        seq = batch.at(-1)?.seq ?? seq;
        const runs = [...new Set(batch.map((e) => e.runId).filter((r): r is string => !!r))];
        if (batch.some((e) => e.kind.startsWith("model."))) scheduleHealth(1000);
        const data = JSON.stringify({ seq, runs });
        for (const c of clients) c.write(`event: journal\ndata: ${data}\n\n`);
      } else if (++beat % 15 === 0) for (const c of clients) c.write(": still here\n\n");
    } catch {
      // a busy database: the next tick catches up from the same seq
    }
  };
  const watch = () => {
    if (!poller) {
      seq = runtime.events.lastSeq();
      poller = setInterval(poll, options.pollMs ?? 1000);
      poller.unref?.();
    }
  };
  const unwatch = () => {
    if (poller && clients.size === 0) {
      clearInterval(poller);
      poller = undefined;
    }
  };

  /*
   * The models indicator: computed in the background every 10 s and soon after model events, kept as
   * the JSON the page asks for — a request never waits for the journal (pilot: the popover stayed
   * shut while the numbers were being collected).
   */
  const PENDING_MODELS = JSON.stringify({
    state: "pending",
    title: "Models: collecting the stats…",
    html: modelsPending().value,
  });
  let modelsJson: string | undefined;
  let healthSoon: ReturnType<typeof setTimeout> | undefined;
  const computeHealth = () => {
    healthSoon = undefined;
    try {
      const health = modelsHealthOf(runtime);
      modelsJson = JSON.stringify({
        state: health.state,
        title: modelsSummary(health),
        html: modelsPopover(health).value,
        ...((b) => (b ? { badge: b } : {}))(modelsBadge(health)),
      });
    } catch {
      // a busy database: the next round tries again
    }
  };
  const scheduleHealth = (ms: number) => {
    if (healthSoon) return;
    healthSoon = setTimeout(computeHealth, ms);
    healthSoon.unref?.();
  };
  const healthTimer = setInterval(() => scheduleHealth(0), 10_000);
  healthTimer.unref?.();
  scheduleHealth(0);

  /*
   * The MCP indicator: the servers as `jarvis mcp list` sees them, the agents' calls of the last half
   * hour, and whether each server answers — a connection of its own at start, every 10 minutes and on
   * "Check now" (a server started by uvx or npx takes seconds to come up: never in a request).
   */
  const PENDING_MCP = JSON.stringify({
    state: "pending",
    title: "MCP: checking the servers…",
    html: mcpPending().value,
  });
  const probes = new Map<string, McpProbe>();
  const checking = new Set<string>();
  let mcpJson: string | undefined;
  const computeMcp = () => {
    try {
      const health = mcpHealthOf(runtime, probes, checking);
      const first = health.servers.some((s) => s.checking && !s.probe);
      mcpJson = JSON.stringify({
        state: first ? "pending" : health.state,
        checking: health.servers.some((s) => s.checking),
        title: first ? "MCP: checking the servers…" : mcpSummary(health),
        html: mcpPopover(health, options.readOnly ? {} : { checkToken: token }).value,
      });
    } catch {
      // a busy database: the next round tries again
    }
  };
  const checkMcp = async () => {
    const ids = runtime.mcp.pool.serverIds().filter((id) => !checking.has(id));
    for (const id of ids) checking.add(id);
    computeMcp();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const { entry, ms } = await runtime.mcp.pool.probe(id);
          probes.set(id, { at: new Date().toISOString(), ok: true, ms, tools: entry.tools.length });
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "error";
          probes.set(id, { at: new Date().toISOString(), ok: false, error: message.slice(0, 300) });
        } finally {
          checking.delete(id);
        }
      }),
    );
    computeMcp();
  };
  const mcpEvery = options.mcpCheckEveryMs ?? 10 * 60_000;
  const mcpChecker = mcpEvery > 0 ? setInterval(() => void checkMcp(), mcpEvery) : undefined;
  mcpChecker?.unref?.();
  const mcpTimer = setInterval(computeMcp, 10_000);
  mcpTimer.unref?.();
  computeMcp();
  if (mcpEvery > 0) void checkMcp();

  // runs the page started: match them to their launches, go on after a wait (src/ui/launcher.ts)
  const tender = options.launcher
    ? setInterval(() => {
        try {
          options.launcher?.tend();
        } catch {
          // a busy database: the next tick tries again
        }
      }, 2000)
    : undefined;
  tender?.unref?.();

  /* ---- answers ---- */
  const send = (r: Request, status: number, body: string, type = "text/html; charset=utf-8", extra = {}) => {
    r.res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    r.res.end(body);
  };
  // ADR-0016 §6: servers out of the data class's network by an exception, said on every page
  const egress = egressNotices(runtime.loaded.config);
  const page = (
    r: Request,
    status: number,
    chrome: Omit<Chrome, "address">,
    content: ReturnType<typeof html>,
  ) => {
    const theme = cookieOf(r.req, "jarvis_theme");
    send(
      r,
      status,
      layout(
        {
          ...chrome,
          address: address(),
          ...(theme === "light" || theme === "dark" ? { theme } : {}),
          ...(options.launcher && actions ? { canStart: true } : {}),
          ...(egress.length > 0 ? { egress } : {}),
        },
        content,
      ),
    );
  };
  const notFound = (r: Request, message: string) =>
    page(
      r,
      404,
      { title: "Not found", page: "error" },
      errorContent(404, message, html`<a href="/">All runs</a>`),
    );

  /** The session token: from the address the first time (then a cookie and a clean address), or the cookie. */
  const authorized = (r: Request): "ok" | "redirect" | "no" => {
    const fromQuery = r.url.searchParams.get("t");
    if (fromQuery && same(fromQuery, token)) return "redirect";
    const fromCookie = cookieOf(r.req, cookie());
    return fromCookie && same(fromCookie, token) ? "ok" : "no";
  };

  /** Requests for another host name (DNS rebinding) are refused before anything else. */
  const hostOk = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const resolveRun = (ref: string): Run | undefined => runtime.runs.resolve(decodeURIComponent(ref));

  const diffOf = async (run: Run): Promise<{ files?: DiffFile[]; note?: string }> => {
    if (!existsSync(run.workspace.path)) return { note: `The run's checkout is gone: ${run.workspace.path}` };
    const base = run.workspace.baseCommit ?? run.workspace.baseRef;
    const r = await git(["diff", "--no-color", "--no-ext-diff", base], run.workspace.path, {
      maxBytes: 4 * 1024 * 1024,
    });
    if (r.code !== 0) return { note: "No diff: the checkout is not a git repository here." };
    return { files: parseDiff(r.stdout) };
  };

  const actions: Actions | undefined = options.readOnly
    ? undefined
    : { token, ...(options.launcher ? { canLaunch: true } : {}) };

  /** What a POST came back with, as a fixed message: nothing from the address is shown as markup. */
  const noticeOf = (r: Request): Html | undefined => {
    const n = r.url.searchParams.get("notice");
    const editor = r.url.searchParams.get("editor") ?? "your editor";
    const notices: Record<string, Html> = {
      opened: html`<div class="banner ok">↗ opened in ${editor} — the page watches the checkout: save there, then run the step again</div>`,
      "no-editor": html`<div class="banner bad">No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start <code>jarvis ui</code></div>`,
      "no-checkout": html`<div class="banner bad">The run's checkout is gone</div>`,
      actor: html`<div class="banner bad">Cannot determine who decides: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)</div>`,
      taken: html`<div class="banner bad">This version was decided meanwhile (in a terminal or another window): yours is not recorded</div>`,
      stale: html`<div class="banner bad">The run no longer waits for this version: nothing recorded</div>`,
      empty: html`<div class="banner bad">Say what to change — a comment, or comments on lines of the diff</div>`,
      "not-waiting": html`<div class="banner bad">The run no longer waits here: nothing recorded</div>`,
      amount: html`<div class="banner bad">Say how many more — a whole number above zero</div>`,
      resumed: html`<div class="banner ok">Resumed — it goes on in the background from where it stopped</div>`,
      cancelled: html`<div class="banner ok">Cancelled — nothing runs it any more; its checkout and artifacts stay</div>`,
      "pause-requested": html`<div class="banner ok">Pause requested — the run stops after its current model or tool call and keeps its place</div>`,
      "not-running": html`<div class="banner info">Nothing runs it now — there is nothing to pause</div>`,
      "cancel-requested": html`<div class="banner ok">Cancel requested — the process running it stops at its next safe point (after the current model or tool call)</div>`,
      "already-ended": html`<div class="banner bad">The run has ended already: nothing to cancel</div>`,
      cleaned: html`<div class="banner ok">Checkout removed — the files go in the background; the branch stays</div>`,
      applied: html`<div class="banner ok">Applied: ${r.url.searchParams.get("files") ?? "?"} file(s) as <code>${r.url.searchParams.get("commit") ?? ""}</code> on the branch checked out in the repository — not pushed</div>`,
      "subtask-started": html`<div class="banner ok">The subtask starts in its service's repository — it shows up here in a moment</div>`,
      "subtask-dropped": html`<div class="banner ok">Dropped from the task; once the others are done the master goes on without it</div>`,
      "no-subtask": html`<div class="banner bad">No such subtask, or its service has no repository on this machine</div>`,
      "apply-failed": html`<div class="banner bad">Not applied: ${r.url.searchParams.get("why") ?? "see jarvis logs"}</div>`,
      restored: html`<div class="banner ok">The branch is back — apply it, or remove it again</div>`,
      "restore-failed": html`<div class="banner bad">The branch could not be restored (a branch of that name exists?)</div>`,
      "cleaned-all": html`<div class="banner ok">Checkout and branch removed — the files go in the background</div>`,
      "cleaned-branch-kept": html`<div class="banner bad">Checkout removed; the branch could not be deleted (checked out somewhere?) — <code>git branch -D</code> it by hand</div>`,
      "not-ended": html`<div class="banner bad">The run has not ended: cancel it first, then clean up</div>`,
      resuming: html`<div class="banner ok">It is being resumed already</div>`,
      "no-launcher": html`<div class="banner bad">This page cannot start runs: resume it with <code>jarvis resume</code></div>`,
      started: html`<div class="banner ok">Started — it prepares its checkout and shows up under Running; where it needs you, it waits here</div>`,
      "no-task": html`<div class="banner bad">Say what to do and pick a workflow</div>`,
      noted: html`<div class="banner ok">The note goes to the agent with its next model call — binding, and for every step after it</div>`,
      "no-note": html`<div class="banner bad">Write the note first</div>`,
      "eval-made": html`<div class="banner ok">The eval case is written: review its case.yaml, then record it once${
        r.url.searchParams.get("skipped")
          ? ` · ${r.url.searchParams.get("skipped")} knowledge file(s) changed after the run began are not in its overlay`
          : ""
      }</div>`,
      "eval-failed": html`<div class="banner bad">No eval case written — see the log of <code>jarvis ui</code> (a run that ended, a repository git can archive)</div>`,
      "eval-suite": html`<div class="banner bad">A suite is a short name: lowercase letters, digits and dashes</div>`,
      "no-answer": html`<div class="banner bad">Write the answer first</div>`,
      clarified: html`<div class="banner ok">The rule is recorded — the step goes on with it in the background</div>`,
      "no-rule": html`<div class="banner bad">Nothing to accept yet: Jarvis has not proposed a rule — answer, or write the rule yourself</div>`,
      "cannot-continue": html`<div class="banner bad">This run cannot go on: it has not finished, has nowhere to go or went on already</div>`,
      "no-repo": html`<div class="banner bad">Not a repository this page knows: start <code>jarvis ui</code> in it</div>`,
    };
    return n ? notices[n] : undefined;
  };

  const redirect = (r: Request, location: string) => {
    r.res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
    r.res.end();
  };

  /**
   * A file a page refers to (`src/…/OrderService.java:44`, refs.ts) in the person's editor: in the
   * run's checkout when the page is a run's (by the referring address), else in the repository. A
   * path the model shortened (`OrderService.java`) is found among the tracked files by its end.
   */
  const openRef = async (r: Request) => {
    const want = (r.url.searchParams.get("path") ?? "").trim().replace(/^\.\//, "");
    const line = Number(r.url.searchParams.get("line"));
    const js = r.url.searchParams.get("js") === "1";
    const answer = (
      status: number,
      body: { opened?: string; path?: string; error?: string; command?: string },
    ) =>
      js
        ? send(r, status, JSON.stringify(body), "application/json")
        : status === 200
          ? send(r, 204, "")
          : notFound(r, body.error ?? "Nothing to open");
    if (!want || want.includes("\0")) return answer(404, { error: "No file to open" });
    let from = "";
    try {
      from = new URL(r.req.headers.referer ?? "").pathname;
    } catch {
      from = "";
    }
    const runRef = /^\/runs\/([^/]+)/.exec(from)?.[1];
    const run = runRef && runRef !== "new" && runRef !== "from" ? resolveRun(runRef) : undefined;
    const roots = [
      ...(run ? [run.workspace.path, run.workspace.repoRoot] : []),
      ...(options.projectRoot ? [options.projectRoot] : knownRepos().slice(0, 1)),
    ].filter((x, i, all) => !!x && all.indexOf(x) === i && existsSync(x));
    for (const root of roots) {
      const rel = await locate(root, want);
      if (!rel) continue;
      const files = [{ path: joinPath(root, rel), ...(Number.isInteger(line) && line > 0 ? { line } : {}) }];
      const label = options.openChecked ? undefined : options.open?.(root, files);
      const checked: OpenResult = options.openChecked
        ? await options.openChecked(root, files)
        : label
          ? { label }
          : {};
      const command = checked.command?.join(" ");
      if (checked.error || !checked.label) {
        if (command) process.stderr.write(`jarvis ui: open failed: ${command}\n${checked.error ?? ""}\n`);
        return answer(404, {
          error:
            checked.error ??
            "No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start jarvis ui",
          ...(command ? { command } : {}),
        });
      }
      return answer(200, { opened: checked.label, path: rel, ...(command ? { command } : {}) });
    }
    return answer(404, { error: `${want} is not a file of ${roots[0] ?? "this repository"}` });
  };
  /** `want` relative to `root`: as is when it is there, else the one tracked file it ends (the shortest). */
  const locate = async (root: string, want: string): Promise<string | undefined> => {
    const abs = resolvePath(root, want);
    if (abs.startsWith(root + sep) && existsSync(abs) && statSync(abs).isFile()) return relative(root, abs);
    if (isAbsolute(want) || want.split("/").includes("..")) return undefined;
    const listed = await git(["ls-files", "-co", "--exclude-standard"], root, { maxBytes: 32 * 1024 * 1024 });
    return listed.stdout
      .split("\n")
      .filter((f) => f === want || f.endsWith(`/${want}`))
      .sort((a, b) => a.length - b.length)[0];
  };

  /** A form posted by the page: url-encoded, small. */
  const formOf = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        body += c;
        if (body.length > 512 * 1024) {
          reject(new Error("form too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(new URLSearchParams(body)));
      req.on("error", reject);
    });

  /** Line comments from the diff, `path:line — text` one a line (ADR-0019 §5). */
  const linesOf = (raw: string | null): string[] => {
    try {
      const v: unknown = JSON.parse(raw || "[]");
      if (!Array.isArray(v)) return [];
      return v
        .slice(0, 500)
        .filter(
          (c): c is { where: string; text: string } =>
            !!c && typeof c.where === "string" && typeof c.text === "string" && c.text.trim().length > 0,
        )
        .map((c) => `${c.where.slice(0, 300)} — ${c.text.trim().slice(0, 4000)}`);
    } catch {
      return [];
    }
  };

  /** Repositories a task may be started in: the one `jarvis ui` runs in and those with runs. */
  const knownRepos = (): string[] => [
    ...new Set([
      ...(options.projectRoot ? [options.projectRoot] : []),
      // a knowledge repository's services on this machine (ADR-0025 §2)
      ...Object.values(runtime.loaded.meta?.repos ?? {}).filter((path) => existsSync(path)),
      ...runtime.runs.list({ includeTerminal: true, limit: 500 }).map((x) => x.workspace.repoRoot),
    ]),
  ];

  /* ---- Knowledge → Modules: research a module, review its candidate, commit the drafts ---- */
  const root = options.projectRoot;
  const roots = () => knowledgeRootsOf(runtime.loaded, root);
  let treeCache: { key: string; tree: Promise<ModuleTree> } | undefined;
  /** The tree for HEAD and the knowledge as it is now (an accepted draft changes the coverage). */
  /**
   * Where the knowledge drafts are versioned: the repository's `.jarvis/`, or for a service its
   * folders in the knowledge repository (ADR-0025 §1), committed there and brought in by a PR.
   */
  const draftsAt = (): { readonly cwd: string; readonly paths: string[] } => {
    const layout = layoutOf(root as string);
    if (!layout.meta)
      return { cwd: root as string, paths: [".jarvis/knowledge", ".jarvis/standards", ".jarvis/skills"] };
    const rel = (abs: string) =>
      relative(layout.meta?.root as string, abs)
        .split(sep)
        .join("/");
    return {
      cwd: layout.meta.root,
      paths: [rel(layout.knowledgeDir), rel(layout.glossaryFile), ".jarvis/standards", ".jarvis/skills"],
    };
  };
  const treeOf = async (): Promise<ModuleTree> => {
    const dir = root as string;
    const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    const at = draftsAt();
    const knowledge = await git(["status", "--porcelain", "--", ...at.paths.slice(0, 2)], at.cwd);
    const key = `${head}|${knowledge.stdout}`;
    if (treeCache?.key !== key) {
      const tree = moduleTree(roots());
      treeCache = { key, tree };
      tree.catch(() => {
        if (treeCache?.tree === tree) treeCache = undefined;
      });
    }
    return treeCache.tree;
  };
  const draftsOf = async (): Promise<Draft[]> => {
    const at = draftsAt();
    const r = await git(["status", "--porcelain", "--untracked-files=all", "--", ...at.paths], at.cwd);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).replace(/^"|"$/g, "") }));
  };
  /** What replacing a person's document with the candidate changes, as a diff. */
  const conflictOf = async (page: Pick<ModulesPage, "selected" | "research">) => {
    const r = page.selected ? page.research.get(page.selected.path) : undefined;
    return r?.kind === "candidate" ? conflictFor(r.candidate) : undefined;
  };
  const conflictFor = async (candidate: Candidate) => {
    if (!root) return undefined;
    const r = { candidate };
    const file = targetOf(root, r.candidate, undefined);
    const before = existingAt(file);
    if (!before || before.generated) return undefined;
    const dir = mkdtempSync(joinPath(tmpdir(), "jarvis-candidate-"));
    try {
      const next = joinPath(dir, "candidate.md");
      const id = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
      writeFileSync(next, contentOf(r.candidate, id));
      const d = await git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--", file, next], dir, {
        maxBytes: 2 * 1024 * 1024,
      });
      const rel = rootRelative(root, file);
      return { file: rel, diff: parseDiff(d.stdout).map((f) => ({ ...f, path: rel })) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /**
   * An ended run's checkout and branch, and a way to remove them (as `jarvis gc` for this one run): a
   * cancelled, failed or finished run leaves a folder and a branch behind until someone cleans up.
   */
  const checkoutOn = async (run: Run): Promise<Html | undefined> => {
    const ws = run.workspace;
    if (ws.mode !== "worktree" || !isTerminal(run.state)) return undefined;
    const exists = existsSync(ws.path);
    const branch = ws.branch;
    const branchExists =
      !!branch &&
      (await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], ws.repoRoot)).code === 0;
    if (!exists && !branchExists) {
      const cleaned = runtime.events.list({ runId: run.id, kind: "run.gc", limit: 1 }).length > 0;
      const kept =
        !!branch &&
        (await git(["rev-parse", "--verify", "-q", `refs/jarvis/removed/${branch}`], ws.repoRoot)).code === 0;
      if (!cleaned && !kept) return undefined;
      return html`<section class="panel" aria-labelledby="checkout"><h2 id="checkout">Checkout</h2>
<p class="muted">Removed: no folder and no branch of this run are left.${kept ? html` Its branch's last commit is kept as <code>refs/jarvis/removed/${branch}</code>.` : ""}</p>
${kept && actions ? html`<form method="post" action="/runs/${encodeURIComponent(shortRunId(run.id))}/restore-branch"><input type="hidden" name="t" value="${actions.token}"><div class="row"><button type="submit" class="btn">Restore the branch</button><span class="hint">then Apply, or remove it again</span></div></form>` : ""}
</section>`;
    }
    // its work taken (applied, or the branch merged into what is checked out): the branch can go
    const taken =
      runtime.events.list({ runId: run.id, kind: "run.applied", limit: 1 }).length > 0 ||
      (branchExists &&
        (await git(["merge-base", "--is-ancestor", branch as string, "HEAD"], ws.repoRoot)).code === 0);
    const keepWork = run.state === "COMPLETED" && !taken;
    const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], ws.repoRoot)).stdout.trim();
    const what = [
      exists ? html`folder <code>${ws.path}</code>` : "",
      branchExists ? html`branch <code>${branch}</code>` : "",
    ].filter(Boolean);
    return html`<section class="panel" aria-labelledby="checkout"><h2 id="checkout">Checkout</h2>
<p class="muted">The run has ended; its ${what.map((w, i) => html`${i > 0 ? " and " : ""}${w}`)} ${what.length > 1 ? "are" : "is"} still there.</p>
${
  actions && branchExists && !taken && run.state === "COMPLETED"
    ? html`<form method="post" action="/runs/${encodeURIComponent(shortRunId(run.id))}/apply"><input type="hidden" name="t" value="${actions.token}"><div class="row"><button type="submit" class="btn primary">Apply to <code>${current}</code></button><span class="hint">the run's changes as one commit on the branch checked out in the repository, as <code>jarvis apply</code>; not pushed</span></div></form>`
    : ""
}
${
  actions
    ? html`<form method="post" action="/runs/${encodeURIComponent(shortRunId(run.id))}/cleanup"><input type="hidden" name="t" value="${actions.token}">
${branchExists ? html`<label class="row"><input type="checkbox" name="branch" value="1"${keepWork ? "" : " checked"}> also delete the branch <code>${branch}</code>${keepWork ? html` — <b>its changes are not applied</b>` : ""}</label>${keepWork ? html`<p class="hint">The branch is the only copy of the run's work: Apply it first, or keep the branch. Deleted, its last commit stays under <code>refs/jarvis/removed/</code> and can be restored here.</p>` : ""}` : ""}
<div class="row"><button type="submit" class="btn">${exists ? "Remove the checkout" : "Delete the branch"}</button><span class="hint">as <code>jarvis gc</code> for this run</span></div>
</form>`
    : ""
}
</section>`;
  };
  /** The candidate of a module research, to decide on its run page; what became of it once decided. */
  const candidateOnRun = async (run: Run): Promise<Html | undefined> => {
    if (run.workflow !== "onboard-module" || !root) return undefined;
    const c = candidatesOf(runtime, (x) => x.id === run.id).at(-1);
    if (!c) return undefined;
    const module = c.doc.module ?? "";
    const modulePage = `/knowledge/modules?path=${encodeURIComponent(module)}`;
    if (c.decision)
      return html`<div class="banner ${c.decision === "approve" ? "ok" : "info"}">${c.decision === "approve" ? "Accepted" : "Discarded"} — <a href="${modulePage}">the module <code>${module}</code></a></div>`;
    if (!actions)
      return html`<div class="banner info">The candidate waits for a review: <a href="${modulePage}">the module <code>${module}</code></a></div>`;
    const conflict = await conflictFor(c);
    return html`<section class="panel mresearch" aria-labelledby="candidate"><h2 id="candidate">Review what the research found: <code>${module}</code></h2>
${candidateReviewHtml(c, run, root, actions, { back: `/runs/${shortRunId(run.id)}`, ...(conflict ? { conflict } : {}) })}
</section>`;
  };
  const knowledgeNotice = (r: Request): Html | undefined => {
    const n = r.url.searchParams.get("notice");
    const count = r.url.searchParams.get("count") ?? "";
    const file = r.url.searchParams.get("file") ?? "";
    const notices: Record<string, Html> = {
      started: html`<div class="banner ok">Research started — it shows up under Runs too; the bell tells you when its candidate is ready</div>`,
      queued: html`<div class="banner ok">${count || "1"} research${count && count !== "1" ? "es" : ""} queued — they run one after another</div>`,
      unqueued: html`<div class="banner ok">Taken out of the queue</div>`,
      resumed: html`<div class="banner ok">Resumed — it goes on in the background from where it stopped</div>`,
      "term-added": html`<div class="banner ok">Added to the glossary as a draft — the next run's searches widen with it</div>`,
      "no-file": html`<div class="banner bad">Not a knowledge file of this repository</div>`,
      "no-path": html`<div class="banner bad">Not a folder of a module here — pick one in the tree or from the path's suggestions</div>`,
      "no-parts": html`<div class="banner bad">Pick at least one part</div>`,
      "check-all": html`<div class="banner bad">Tick every statement under «Check these first» — or send it back with a note</div>`,
      taken: html`<div class="banner bad">The target was written by a person: replace it, or write under another name</div>`,
      accepted: html`<div class="banner ok">Written to <code>${file}</code> — not committed yet</div>`,
      rejected: html`<div class="banner ok">Discarded — nothing written</div>`,
      again: html`<div class="banner ok">Discarded, and researching again with your note</div>`,
      decided: html`<div class="banner bad">This candidate was decided meanwhile (in a terminal or another window)</div>`,
      committed: html`<div class="banner ok">Committed: ${file}</div>`,
      "nothing-to-commit": html`<div class="banner bad">Nothing to commit under .jarvis/</div>`,
      "commit-failed": html`<div class="banner bad">git commit failed — see <code>jarvis logs --event ui.commit</code></div>`,
      opened: html`<div class="banner ok">↗ opened in ${r.url.searchParams.get("editor") ?? "your editor"}</div>`,
      "no-editor": html`<div class="banner bad">No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start <code>jarvis ui</code></div>`,
      actor: html`<div class="banner bad">Cannot determine who decides: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)</div>`,
    };
    return n ? notices[n] : undefined;
  };
  const modulesPageOf = async (r: Request): Promise<void> => {
    if (!root || !existsSync(root))
      return notFound(r, "Knowledge needs a repository: start jarvis ui in one.");
    const tree = await treeOf();
    const path = (r.url.searchParams.get("path") ?? "").trim().replace(/\/+$/, "") || undefined;
    const selected = path ? findNode(tree, path) : undefined;
    const research = researchOf(runtime, options.launcher?.list() ?? [], root);
    const base = {
      tree,
      ...(path ? { path } : {}),
      ...(selected ? { selected } : {}),
      need: r.url.searchParams.get("need") === "1",
      research,
      drafts: await draftsOf(),
      canStart: !!options.launcher && !!actions,
      root,
      counts: countsOf(),
    };
    const conflict = await conflictOf(base);
    const running = [...research.values()].some((x) =>
      ["starting", "running", "paused", "queued"].includes(x.kind),
    );
    return page(
      r,
      200,
      {
        title: path ? `Modules · ${path}` : "Modules",
        page: "knowledge",
        ...(running ? { tick: 5000 } : {}),
      },
      modulesContent({ ...base, ...(conflict ? { conflict } : {}) }, actions, knowledgeNotice(r)),
    );
  };
  const back = (path: string, notice: string, extra = "") =>
    `/knowledge/modules?${path ? `path=${encodeURIComponent(path)}&` : ""}notice=${notice}${extra}`;
  /** POST /knowledge/…: research, the queue, a candidate's decision, the commit, open in editor. */
  const knowledgePost = async (r: Request): Promise<void> => {
    if (!root || !actions) return notFound(r, `Nothing to do at ${r.url.pathname}.`);
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const pathOf = () => (form.get("path") ?? "").trim().replace(/\/+$/, "");
    const at = r.url.pathname;
    // where a commit or an "open" goes back to: a Knowledge page of this server, nothing else
    const backTo = (notice: string, extra = "") => {
      const b = form.get("back") ?? "";
      if (!/^\/knowledge(\/[a-z]+)?(\?[^#]*)?$/.test(b)) return back(pathOf(), notice, extra);
      const u = new URL(b, "http://x");
      u.searchParams.set("notice", notice);
      for (const [k, v] of new URLSearchParams(extra.replace(/^&/, ""))) u.searchParams.set(k, v);
      return `${u.pathname}${u.search}`;
    };
    if (at === "/knowledge/glossary") return glossaryPost(r, form);
    if (at === "/knowledge/ask") return askPost(r, form);
    if (at === "/knowledge/modules/research") {
      if (!options.launcher) return notFound(r, "Starting research is off here.");
      const tree = await treeOf();
      const paths = [...new Set(form.getAll("path").map((p) => p.trim().replace(/\/+$/, "")))].filter(
        Boolean,
      );
      if (paths.length === 0) return redirect(r, back(pathOf(), "no-parts"));
      if (paths.some((p) => !findNode(tree, p))) return redirect(r, back(paths[0] as string, "no-path"));
      const note = (form.get("note") ?? "").trim().slice(0, NOTE_MAX);
      const launches = paths.map((module) =>
        options.launcher?.startModule({ module, repoRoot: root, ...(note ? { note } : {}) }),
      );
      const waiting = launches.filter((l) => l?.queued).length;
      return redirect(
        r,
        back(paths[0] as string, waiting > 0 ? "queued" : "started", waiting > 0 ? `&count=${waiting}` : ""),
      );
    }
    if (at === "/knowledge/modules/unqueue") {
      options.launcher?.unqueue(form.get("launch") ?? "");
      return redirect(r, back(pathOf(), "unqueued"));
    }
    if (at === "/knowledge/commit") {
      const drafts = await draftsOf();
      if (drafts.length === 0) return redirect(r, backTo("nothing-to-commit"));
      const files = drafts.map((d) => d.path);
      const names = files.map((f) => f.replace(/^.*\//, "").replace(/\.md$/, "")).slice(0, 4);
      const message = `knowledge: ${names.join(", ")}${files.length > names.length ? ` and ${files.length - names.length} more` : ""}`;
      const at = draftsAt();
      const add = await git(["add", "-A", "--", ...files], at.cwd);
      // the author is the repository's git config, as for any commit made by hand
      const commit =
        add.code === 0 ? await git(["commit", "-q", "-m", message, "--", ...files], at.cwd) : add;
      if (commit.code !== 0) {
        runtime.log.error("ui.commit", { message: commit.stderr.slice(0, 2000) });
        return redirect(r, backTo("commit-failed"));
      }
      return redirect(r, backTo("committed", `&file=${encodeURIComponent(files.join(", "))}`));
    }
    if (at === "/knowledge/open") {
      const file = (form.get("file") ?? "").replace(/^\/+/, "");
      // a knowledge file: under .jarvis/ (the knowledge repository's for a service), or a document or
      // skill of knowledge.sources
      const abs = resolvePath(root, file);
      const layout = layoutOf(root);
      const inside = (dir: string) => abs.startsWith(resolvePath(dir) + sep);
      const known =
        inside(layout.jarvisDir) ||
        (layout.meta ? inside(layout.meta.knowledgeRoot) : false) ||
        (await docsOf(roots())).some((d) => d.path === file) ||
        skillsOf(roots()).some((x) => x.path === file);
      if (!known || !existsSync(joinPath(root, file))) return redirect(r, backTo("no-file"));
      const editor = options.open?.(root, [{ path: joinPath(root, file) }]);
      return redirect(
        r,
        editor ? backTo("opened", `&editor=${encodeURIComponent(editor)}`) : backTo("no-editor"),
      );
    }
    const m = /^\/knowledge\/candidates\/([^/]+)\/(accept|reject)$/.exec(at);
    if (!m) return notFound(r, `Nothing to do at ${at}.`);
    const id = decodeURIComponent(m[1] as string);
    const all = candidatesOf(runtime, (run) => run.workflow === "onboard-module");
    const c = all.find((x) => x.artifact.artifactId === id);
    if (!c) return notFound(r, "No such candidate.");
    const module = c.doc.module ?? "";
    // decided on the research's run page: back there
    const onRun = /^\/runs\/[A-Za-z0-9_-]+$/.exec(form.get("back") ?? "")?.[0];
    const after = (path: string, notice: string, extra = "") =>
      onRun ? `${onRun}?notice=${notice}${extra}` : back(path, notice, extra);
    if (c.decision) return redirect(r, after(module, "decided"));
    const who = options.actor ? await options.actor() : undefined;
    if (!who) return redirect(r, after(module, "actor"));
    if (m[2] === "accept") {
      const checked = new Set(form.getAll("checked").map(Number));
      if (c.review.some((_, i) => !checked.has(i))) return redirect(r, after(module, "check-all"));
      const fileId = (form.get("id") ?? "").trim();
      try {
        const done = promoteCandidate(runtime, {
          root,
          candidate: c,
          actor: who,
          ...(/^[a-z0-9][a-z0-9._-]{0,59}$/.test(fileId) ? { id: fileId } : {}),
          replace: form.get("replace") === "1",
          channel: "ui",
          checked: checked.size,
        });
        return redirect(r, after(module, "accepted", `&file=${encodeURIComponent(done.path)}`));
      } catch (error) {
        if (!(error instanceof CandidateTargetTaken)) throw error;
        return redirect(r, after(module, "taken"));
      }
    }
    const comment = (form.get("comment") ?? "").trim().slice(0, NOTE_MAX);
    rejectCandidate(runtime, c, who, comment || undefined);
    if (form.get("again") === "1" && options.launcher && module) {
      const dropped = (c.doc.dropped ?? []).slice(0, 12).map((d) => `- ${d.section} "${d.what}": ${d.why}`);
      const note = [
        comment,
        dropped.length > 0
          ? `The previous research had these claims dropped by the check against the code:\n${dropped.join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, NOTE_MAX);
      options.launcher.startModule({ module, repoRoot: root, ...(note ? { note } : {}) });
      return redirect(r, after(module, "again"));
    }
    return redirect(r, after(module, "rejected"));
  };

  /* ---- Knowledge: overview, documents, standards, skills, glossary (read-only, a glossary term added) ---- */
  const countsOf = (): KnowledgeCounts => {
    const r = roots();
    const safe = (f: () => number) => {
      try {
        return f();
      } catch {
        return 0;
      }
    };
    return {
      docs: safe(() => loadKnowledgeDocs(r).length),
      standards: safe(() => loadStandards(r).length),
      skills: safe(() => loadSkills(r).length),
      terms: safe(() => loadGlossary(root).length),
    };
  };
  let glossaryCache: { key: string; view: Promise<GlossaryView> } | undefined;
  const glossaryView = async (): Promise<GlossaryView> => {
    const dir = root as string;
    const file = layoutOf(dir).glossaryFile;
    const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    const st = existsSync(file) ? statSync(file) : undefined;
    const key = `${head}|${st?.mtimeMs ?? 0}|${st?.size ?? 0}`;
    if (glossaryCache?.key !== key) glossaryCache = { key, view: glossaryOf(dir) };
    return glossaryCache.view;
  };
  /** A knowledge page: its content, then the drafts strip (every page commits the same way). */
  const knowledgePage = async (r: Request, title: string, content: Html, back: string) =>
    page(
      r,
      200,
      { title, page: "knowledge" },
      html`${content}${draftsHtml(await draftsOf(), back, actions)}`,
    );
  /** Standards and skills are files people write: a broken one is said on the page, not a 500. */
  const loadError = (error: unknown): Html =>
    html`<div class="banner bad">${(error as Error)?.message ?? String(error)}</div>`;
  const knowledgeGet = async (r: Request): Promise<void> => {
    if (!root || !existsSync(root))
      return notFound(r, "Knowledge needs a repository: start jarvis ui in one.");
    const at = r.url.pathname.replace(/\/+$/, "") || "/knowledge";
    const q = (name: string) => r.url.searchParams.get(name) ?? undefined;
    const counts = countsOf();
    const notice = knowledgeNotice(r);
    const usage = usageOf(runtime);
    if (at === "/knowledge") {
      const query = q("q")?.trim().slice(0, 300);
      let result: RetrievalResult | undefined;
      let searchError: string | undefined;
      if (query) {
        try {
          await refreshIndex(runtime, roots());
          result = await search(runtime, roots(), query, { limit: 10 });
        } catch (error) {
          searchError = `The search failed: ${(error as Error)?.message ?? String(error)}`;
        }
      }
      const tree = await treeOf();
      const toResearch = researchFirst(tree.modules);
      const candidates = candidatesOf(runtime, (run) => run.workflow === "onboard-module").filter(
        (c) => !c.decision && c.doc.module,
      ).length;
      const glossary = await glossaryView();
      const content = overviewContent(
        {
          counts,
          docs: await docsOf(roots(), usage),
          glossaryProblems: glossary.rows.filter((x) => x.problems.length > 0).length,
          toResearch,
          candidates,
          ...(query ? { query } : {}),
          ...(result ? { result } : {}),
          ...(searchError ? { searchError } : {}),
        },
        notice,
      );
      return knowledgePage(r, query ? `Knowledge · ${query}` : "Knowledge", content, "/knowledge");
    }
    if (at === "/knowledge/docs") {
      const docs = await docsOf(roots(), usage);
      const want = q("doc");
      // by path, or by name (`?doc=architecture.md` — wherever the project keeps its knowledge)
      const selected = want ? docs.find((d) => d.path === want || d.name === want) : docs[0];
      const content = docsContent(
        {
          counts,
          docs,
          ...(selected ? { selected } : {}),
          ...(want ? { path: want } : {}),
          architecture: selected?.name === ARCHITECTURE,
        },
        actions,
        notice,
      );
      return knowledgePage(
        r,
        selected ? `Knowledge · ${selected.path}` : "Knowledge · documents",
        content,
        r.url.pathname + r.url.search,
      );
    }
    if (at === "/knowledge/standards") {
      let content: Html;
      try {
        const standards = standardsOf(runtime, roots(), usage);
        const severity = q("severity");
        const sev = severity === "required" || severity === "recommended" ? severity : undefined;
        const id = q("id");
        const selected = id
          ? standards.find((s) => s.id === id)
          : standards.find((s) => !sev || s.severity === sev);
        content = standardsContent(
          { counts, standards, ...(selected ? { selected } : {}), ...(sev ? { severity: sev } : {}) },
          actions,
          notice,
        );
      } catch (error) {
        content = html`${knowledgeTabs("standards", counts)}${loadError(error)}`;
      }
      return knowledgePage(r, "Knowledge · standards", content, r.url.pathname + r.url.search);
    }
    if (at === "/knowledge/skills") {
      let content: Html;
      try {
        const skills = skillsOf(roots(), usage);
        const id = q("id");
        const selected = id
          ? skills.find((s) => `${s.skill.id}${s.overridden ? "@builtin" : ""}` === id)
          : skills[0];
        content = skillsContent({ counts, skills, ...(selected ? { selected } : {}) }, actions, notice);
      } catch (error) {
        content = html`${knowledgeTabs("skills", counts)}${loadError(error)}`;
      }
      return knowledgePage(r, "Knowledge · skills", content, r.url.pathname + r.url.search);
    }
    if (at === "/knowledge/ask") {
      const ref = q("run");
      const found = ref ? runtime.runs.resolve(ref) : undefined;
      const run = found?.workflow === "ask" ? found : undefined;
      const question = (q("q") ?? "").trim().slice(0, 500);
      let current: AskView | undefined;
      let error: string | undefined;
      if (run) current = askOfRun(runtime, roots(), run);
      else if (question) {
        // Sources only: the search without a model, at once, no run
        try {
          const p = await plan(runtime, roots(), question, 8);
          current = {
            question,
            general: false,
            modelCalls: 0,
            terms: p.terms,
            sources: p.retrieval.evidence.map((e) => ({
              ref: e.ref,
              kind: e.kind,
              title: e.title,
              ...(e.snippet ? { snippet: e.snippet.replace(/\s+/g, " ").slice(0, 300) } : {}),
              path: e.retrievalPath.map((x) => `${x.index}#${x.rank}`).join(","),
            })),
            ...(p.retrieval.expansions.length > 0 ? { expansions: p.retrieval.expansions } : {}),
          };
        } catch (e) {
          error = `The search failed: ${(e as Error)?.message ?? String(e)}`;
        }
      } else if (ref) error = `No question ${ref} here.`;
      const content = askContent(
        {
          counts,
          ...(current ? { current } : {}),
          recent: recentAsks(runtime, roots()),
          form: {
            q: current?.question ?? question,
            mode: run || !question ? "answer" : q("mode") === "sources" ? "sources" : "answer",
            general: current?.general ?? false,
          },
          ...(error ? { error } : {}),
        },
        actions,
      );
      return knowledgePage(
        r,
        current ? `Ask · ${current.question.slice(0, 60)}` : "Knowledge · ask",
        content,
        "/knowledge/ask",
      );
    }
    if (at === "/knowledge/glossary") {
      const glossary = await glossaryView();
      const term = q("term");
      const selected = term ? glossary.rows.find((x) => x.term === term) : undefined;
      const where = selected ? [...(await checkSymbols(root, selected.symbols)).values()] : undefined;
      const add = q("add");
      const content = glossaryContent(
        {
          counts,
          glossary,
          ...(selected ? { selected } : {}),
          ...(where ? { where } : {}),
          problems: q("problems") === "1",
          ...(q("q") ? { filter: q("q") as string } : {}),
          ...(add
            ? { form: { term: add.slice(0, 80), synonyms: "", symbols: "", sources: "", definition: "" } }
            : {}),
        },
        actions,
        notice,
      );
      return knowledgePage(
        r,
        term ? `Glossary · ${term}` : "Knowledge · glossary",
        content,
        r.url.pathname + r.url.search,
      );
    }
    return notFound(r, `Nothing at ${r.url.pathname}.`);
  };
  /** Add a term: check its symbols first; one that is not in the code asks for «Add anyway». */
  const glossaryPost = async (r: Request, form: URLSearchParams): Promise<void> => {
    const dir = root as string;
    const list = (name: string) =>
      (form.get(name) ?? "")
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30);
    const values = {
      term: (form.get("term") ?? "").trim().slice(0, 80),
      synonyms: (form.get("synonyms") ?? "").trim().slice(0, 400),
      symbols: (form.get("symbols") ?? "").trim().slice(0, 400),
      sources: (form.get("sources") ?? "").trim().slice(0, 200),
      definition: (form.get("definition") ?? "").trim().slice(0, 600),
    };
    const checks = [...(await checkSymbols(dir, list("symbols"))).values()];
    const again = async (error?: string) =>
      knowledgePage(
        r,
        "Knowledge · glossary",
        glossaryContent(
          {
            counts: countsOf(),
            glossary: await glossaryView(),
            problems: false,
            form: values,
            checks,
            ...(error ? { error } : {}),
          },
          actions,
        ),
        "/knowledge/glossary",
      );
    const doing = form.get("do");
    if (!values.term) return again("Say the term");
    if (doing === "check" || (doing === "add" && checks.some((c) => !c.found))) return again();
    try {
      addGlossaryTerm(dir, {
        term: values.term,
        synonyms: list("synonyms"),
        symbols: list("symbols"),
        sources: list("sources"),
        ...(values.definition ? { definition: values.definition } : {}),
      });
    } catch (error) {
      if (!(error instanceof GlossaryTermTaken)) throw error;
      return again(error.message);
    }
    glossaryCache = undefined;
    return redirect(r, `/knowledge/glossary?term=${encodeURIComponent(values.term)}&notice=term-added`);
  };

  /**
   * Ask: the search now, then the answering run in this process, in the background; the page goes to the
   * run as soon as it exists and follows it there (its sources are on the page before the model answers).
   */
  const askPost = async (r: Request, form: URLSearchParams): Promise<void> => {
    const question = (form.get("q") ?? "").trim().slice(0, 500);
    if (!question) return redirect(r, "/knowledge/ask");
    const general = form.get("general") === "1";
    const sourcesOnly = `/knowledge/ask?q=${encodeURIComponent(question)}&mode=sources`;
    if (form.get("mode") === "sources") return redirect(r, sourcesOnly);
    const dir = root as string;
    const p = await plan(runtime, roots(), question, 8);
    // the model only when it can add something: sources to read, or general knowledge asked for (as the CLI)
    if (p.retrieval.evidence.length === 0 && !general) return redirect(r, sourcesOnly);
    let started: (id: string) => void = () => {};
    const created = new Promise<string>((resolve) => {
      started = resolve;
    });
    const job = answerFromKnowledge(runtime, {
      root: dir,
      roots: roots(),
      question,
      evidence: p.retrieval.evidence,
      allowGeneral: general,
      env: process.env,
      ...(p.retrieval.expansions.length > 0 ? { expansions: p.retrieval.expansions } : {}),
      onRun: (id) => started(id),
    });
    job.catch((error) =>
      runtime.log.error("ui.ask", { message: (error as Error)?.message ?? String(error) }),
    );
    const first = await Promise.race([created, job.then((x) => x.runId || `!${x.problem ?? "no run"}`)]);
    if (first.startsWith("!")) {
      const content = askContent(
        {
          counts: countsOf(),
          recent: recentAsks(runtime, roots()),
          form: { q: question, mode: "answer", general },
          error: first.slice(1),
        },
        actions,
      );
      return knowledgePage(r, "Knowledge · ask", content, "/knowledge/ask");
    }
    return redirect(r, `/knowledge/ask?run=${encodeURIComponent(first.replace(/^run_/, "").slice(0, 8))}`);
  };

  /** Answers being prepared for a document version here; each version is tried once per server. */
  const tried = new Map<string, boolean>();
  const prepareOnce = (run: Run, doc: ArtifactVersion): boolean => {
    const key = `${doc.artifactId}@${doc.version}`;
    const state = tried.get(key);
    if (state !== undefined) return state;
    tried.set(key, true);
    prepareSuggestions(runtime, run, doc, run.currentStep ?? "approve")
      .catch(() => undefined)
      .finally(() => tried.set(key, false));
    return true;
  };

  /** One launch per run gone on: a second click while the first prepares its checkout joins it. */
  const continueFrom = (launcher: Launcher, from: Run, workflow: Workflow): Launch =>
    launcher.list().find((l) => l.from === from.id && (l.exitCode === null || l.exitCode === 0 || l.runId)) ??
    launcher.continueRun(from, workflow);

  /** Workflows a finished run goes on as (`next:`): "New task" offers a research to start them from. */
  const targets = (): Set<string> =>
    new Set(
      WORKFLOWS.map((w) => {
        try {
          return engine.workflow(w.id).next;
        } catch {
          return undefined;
        }
      }).filter((w): w is string => w !== undefined),
    );

  /** `GET /runs/from?task=&workflow=&repo=`: the box under "New task" (src/app/continuation.ts). */
  const startFrom = async (r: Request): Promise<void> => {
    if (!options.launcher || !actions) return notFound(r, "Starting tasks is off here.");
    const q = r.url.searchParams;
    const task = (q.get("task") ?? "").slice(0, 4000);
    const workflow = q.get("workflow") ?? "";
    const repo = q.get("repo") || options.projectRoot || "";
    const known = knownRepos().includes(repo);
    const point =
      known && task.trim()
        ? await startPointOf(runtime, engine, { task, workflow, repoRoot: repo })
        : undefined;
    const body = known ? startFromHtml(point, { task, workflow, targets: targets() }, Date.now()) : "";
    return send(r, 200, String(body), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  };

  /** "New task": the CLI started in the background, driven by the page (src/ui/launcher.ts). */
  const startTask = async (r: Request): Promise<void> => {
    const launcher = options.launcher;
    if (!launcher || !actions) return notFound(r, "Starting tasks is off here.");
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const task = (form.get("task") ?? "").trim().slice(0, 4000);
    const workflow = WORKFLOWS.find((w) => w.id === form.get("workflow"))?.id;
    const repo = form.get("repo") ?? options.projectRoot ?? "";
    if (!task || !workflow) return redirect(r, "/?notice=no-task#new");
    if (!knownRepos().includes(repo) || !existsSync(repo)) return redirect(r, "/?notice=no-repo#new");
    const fromRef = form.get("from");
    if (fromRef) {
      // started from a finished research (the box under the form): `jarvis continue <run>`
      const from = resolveRun(fromRef);
      const next = from ? continuationOf(runtime, engine, from) : undefined;
      if (!from || next?.workflow !== workflow || from.workspace.repoRoot !== repo)
        return redirect(r, "/?notice=cannot-continue#new");
      return redirect(r, `/launches/${continueFrom(launcher, from, workflow).id}`);
    }
    const freshDesign = form.get("fresh") === "design";
    const launch = launcher.start({
      task,
      workflow,
      repoRoot: repo,
      ...(freshDesign ? { freshDesign } : {}),
    });
    // straight to the launch: it becomes the run's page as soon as the run begins
    return redirect(r, `/launches/${launch.id}`);
  };

  /** Accept / Send back / Run again / Open in editor: the same functions as the terminal's keys. */
  const post = async (r: Request): Promise<void> => {
    if (r.url.pathname === "/runs/new") return startTask(r);
    if (r.url.pathname.startsWith("/knowledge/")) return knowledgePost(r);
    if (r.url.pathname === "/mcp/check") {
      if (!actions) return notFound(r, "Nothing to do at /mcp/check.");
      const sent = (await formOf(r.req)).get("t");
      if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
      void checkMcp();
      return send(r, 202, mcpJson ?? PENDING_MCP, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    const m =
      /^\/runs\/([^/]+)\/(decide|rerun|open|budget|resume|cancel|continue|clarify|eval|note|pause|cleanup|apply|restore-branch|subtask)$/.exec(
        r.url.pathname,
      );
    const run = m ? resolveRun(m[1] as string) : undefined;
    if (!m || !run || !actions) return notFound(r, `Nothing to do at ${r.url.pathname}.`);
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const short = shortRunId(run.id);
    const actor = async () => (options.actor ? await options.actor() : undefined);
    // after a decision here: a terminal waiting at the card goes on with it; else the page does —
    // also a run a terminal started and then left (pilot: more granted here, nothing went on)
    const goOn = (r: Run): void => {
      if (options.launcher && !waitingCard(runtime, r.id)) options.launcher.adopt(r);
    };
    if (m[2] === "subtask") {
      // a master's subtask (ADR-0025 §6): start a queued one now, retry a stopped one, drop one
      const key = form.get("key") ?? "";
      const act = form.get("act");
      const view = subtasksOf(runtime, run).find((v) => v.subtask.key === key);
      if (!view) return redirect(r, `/runs/${short}?notice=no-subtask`);
      if (act === "drop") {
        const who = await actor();
        runtime.events.emit({
          kind: "subtask.dropped",
          runId: run.id,
          ...(who ? { actor: `${who.kind}:${who.id}` } : {}),
          payload: { key, service: view.subtask.service, channel: "ui" },
        });
        const current = runtime.runs.get(run.id) ?? run;
        if (subtasksOf(runtime, current).every(isDone) && current.waitingFor?.kind === "children")
          resumeMaster(runtime, current);
        return redirect(r, `/runs/${short}?notice=subtask-dropped`);
      }
      if (act === "retry" && view.run && view.state === "FAILED") {
        options.launcher?.adopt(view.run);
        return redirect(r, `/runs/${short}?notice=subtask-started`);
      }
      const started = startSubtask(runtime, run, key);
      return redirect(r, `/runs/${short}?notice=${started.ok ? "subtask-started" : "no-subtask"}`);
    }
    if (m[2] === "note") {
      // a note to the running step: binding for its agent from its next model call, and for the rest
      const text = (form.get("text") ?? "").trim();
      if (!text) return redirect(r, `/runs/${short}?notice=no-note`);
      if (isTerminal(run.state)) return redirect(r, `/runs/${short}?notice=already-ended`);
      const who = await actor();
      if (!who) return redirect(r, `/runs/${short}?notice=actor`);
      addNote(runtime, run, text, who.id);
      return redirect(r, `/runs/${short}?notice=noted`);
    }
    if (m[2] === "eval") {
      // «Make an eval case»: as `jarvis evals run-to-case <run> --suite <suite>`
      const suite = (form.get("suite") ?? "default").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(suite)) return redirect(r, `/runs/${short}?notice=eval-suite`);
      if (run.state !== "COMPLETED") return redirect(r, `/runs/${short}?notice=eval-failed`);
      if (caseOfRun(run.workspace.repoRoot, run.id)) return redirect(r, `/runs/${short}?notice=eval-made`);
      let skipped = 0;
      try {
        const made = await runToCase(runtime, run.id, {
          suiteDir: joinPath(run.workspace.repoRoot, "evals", suite),
        });
        skipped = made.skipped?.length ?? 0;
      } catch (error) {
        runtime.log.error("ui.eval", {
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return redirect(r, `/runs/${short}?notice=eval-failed`);
      }
      return redirect(r, `/runs/${short}?notice=eval-made${skipped > 0 ? `&skipped=${skipped}` : ""}`);
    }
    if (m[2] === "clarify") {
      // the clarification thread answered here (ADR-0019 §4), the moves of `jarvis attach`
      const thread = runtime.interactions.openFor(run.id, "clarification");
      if (run.waitingFor?.kind !== "clarification" || !thread)
        return redirect(r, `/runs/${short}?notice=not-waiting`);
      const who = await actor();
      if (!who) return redirect(r, `/runs/${short}?notice=actor`);
      const move = form.get("move");
      const text = (form.get("text") ?? "").trim();
      const rule = (form.get("rule") ?? "").trim();
      if (move === "say") {
        if (!text) return redirect(r, `/runs/${short}?notice=no-answer#decision`);
        // the answer is on the thread at once; Jarvis's turn (a model call) comes in the background
        humanMove(runtime, run, thread, who, { text }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          runtime.log.error("ui.clarify", { runId: run.id, message });
          runtime.interactions.say(thread.id, {
            role: "jarvis",
            actor: "clarifier",
            text: `⚠ No answer from the model: ${message}. Send the answer again, or write the rule yourself.`,
          });
        });
        return redirect(r, `/runs/${short}#decision`);
      }
      if (move?.startsWith("earlier-")) {
        // a rule settled in another run of the same task, looked up again here: nothing taken from the form
        const earlier = earlierRulesFor(runtime, run)[Number(move.slice(8))];
        if (!earlier) return redirect(r, `/runs/${short}?notice=no-rule#decision`);
        await humanMove(runtime, run, thread, who, { accept: true, rule: earlier.rule });
        goOn(runtime.runs.get(run.id) ?? run);
        return redirect(r, `/runs/${short}?notice=clarified`);
      }
      if (move === "accept" || move === "rule") {
        if (move === "rule" && !rule) return redirect(r, `/runs/${short}?notice=no-rule#decision`);
        try {
          await humanMove(runtime, run, thread, who, {
            accept: true,
            ...(move === "rule" ? { rule } : {}),
            ...(text ? { text } : {}),
          });
        } catch {
          return redirect(r, `/runs/${short}?notice=no-rule#decision`);
        }
        const now = runtime.runs.get(run.id) ?? run;
        goOn(now);
        return redirect(r, `/runs/${short}?notice=clarified`);
      }
      return redirect(r, `/runs/${short}`);
    }
    if (m[2] === "continue") {
      // "Continue to sdd" on a finished research/spec: as `jarvis continue <run>`, in the background
      if (!options.launcher) return redirect(r, `/runs/${short}?notice=no-launcher`);
      const next = continuationOf(runtime, engine, run);
      const workflow = WORKFLOWS.find((w) => w.id === next?.workflow)?.id;
      if (!workflow) {
        const by = continuedBy(runtime, run);
        return redirect(r, by ? `/runs/${shortRunId(by)}` : `/runs/${short}?notice=cannot-continue`);
      }
      return redirect(r, `/launches/${continueFrom(options.launcher, run, workflow).id}`);
    }
    if (m[2] === "open") {
      if (!existsSync(run.workspace.path)) return redirect(r, `/runs/${short}?notice=no-checkout`);
      // the files the loop's reasons name first, at their lines, then what the run changed (as `o`)
      const record =
        run.waitingFor?.kind === "loop"
          ? runtime.artifacts.listLatest(run.id, "loop-exhausted")[0]
          : undefined;
      let reasons = "";
      try {
        const doc = record ? (JSON.parse(runtime.artifacts.text(record)) as { reason?: unknown }) : undefined;
        reasons = typeof doc?.reason === "string" ? doc.reason : "";
      } catch {
        reasons = "";
      }
      const files = reviewFiles(
        run.workspace.path,
        run.workspace.baseCommit ?? run.workspace.baseRef,
        reasons,
      );
      const editor = options.open?.(run.workspace.path, files);
      // back where it was asked: the run page, or the implementation's page («Try it»)
      const ret = form.get("return") ?? "";
      const where = ret.startsWith(`/runs/${short}/artifacts/`) && !/[?#]/.test(ret) ? ret : `/runs/${short}`;
      return redirect(
        r,
        editor ? `${where}?notice=opened&editor=${encodeURIComponent(editor)}` : `${where}?notice=no-editor`,
      );
    }
    if (m[2] === "apply") {
      // as `jarvis apply`: the run's own changes, one commit on the branch checked out in the repository
      if (!isTerminal(run.state)) return redirect(r, `/runs/${short}?notice=not-ended`);
      if (run.workspace.mode !== "worktree") return redirect(r, `/runs/${short}?notice=no-checkout`);
      const who = await actor();
      if (!who) return redirect(r, `/runs/${short}?notice=actor`);
      try {
        const done = await applyRun(runtime, run, who, process.env);
        return redirect(
          r,
          `/runs/${short}?notice=applied&files=${done.files.length}&commit=${done.commit.slice(0, 10)}`,
        );
      } catch (error) {
        if (!(error instanceof WorktreeError)) throw error;
        return redirect(
          r,
          `/runs/${short}?notice=apply-failed&why=${encodeURIComponent(error.message.slice(0, 600))}`,
        );
      }
    }
    if (m[2] === "restore-branch") {
      // a branch deleted with its checkout, back from the commit kept for it
      const b = run.workspace.branch;
      if (!b) return redirect(r, `/runs/${short}?notice=no-checkout`);
      const kept = `refs/jarvis/removed/${b}`;
      const made = await git(["branch", b, kept], run.workspace.repoRoot);
      if (made.code !== 0) return redirect(r, `/runs/${short}?notice=restore-failed`);
      await git(["update-ref", "-d", kept], run.workspace.repoRoot);
      return redirect(r, `/runs/${short}?notice=restored`);
    }
    if (m[2] === "cleanup") {
      // an ended run's own checkout, and on request its branch: as `jarvis gc` for one run
      if (!isTerminal(run.state)) return redirect(r, `/runs/${short}?notice=not-ended`);
      const ws = run.workspace;
      if (ws.mode !== "worktree") return redirect(r, `/runs/${short}?notice=no-checkout`);
      const who = await actor();
      if (!who) return redirect(r, `/runs/${short}?notice=actor`);
      const pruneBranch = form.get("branch") === "1" && !!ws.branch;
      const hadCheckout = existsSync(ws.path);
      if (hadCheckout) await new WorktreeWorkspace(ws, process.env).remove({ pruneBranch });
      else if (pruneBranch) await deleteBranchKeepingTip(ws.repoRoot, ws.branch as string);
      const branchLeft =
        pruneBranch &&
        (await git(["rev-parse", "--verify", "-q", `refs/heads/${ws.branch}`], ws.repoRoot)).code === 0;
      runtime.events.emit({
        kind: "run.gc",
        runId: run.id,
        actor: `${who.kind}:${who.id}`,
        payload: {
          path: ws.path,
          checkout: hadCheckout,
          branchPruned: pruneBranch && !branchLeft,
          via: "ui",
        },
      });
      return redirect(
        r,
        `/runs/${short}?notice=${branchLeft ? "cleaned-branch-kept" : pruneBranch ? "cleaned-all" : "cleaned"}`,
      );
    }
    if (m[2] === "pause") {
      // as Ctrl-C, from another process: at the next safe point, the place kept (src/app/pause.ts)
      if (run.state !== "RUNNING" || run.cancelRequested)
        return redirect(r, `/runs/${short}?notice=not-running`);
      if (!pauseRequested(runtime, run.id)) {
        const who = await actor();
        if (!who) return redirect(r, `/runs/${short}?notice=actor`);
        requestPause(runtime, run, `${who.kind}:${who.id}`, "ui");
      }
      return redirect(r, `/runs/${short}?notice=pause-requested`);
    }
    if (m[2] === "cancel") {
      // as `jarvis cancel`: at once when nothing executes it, else at its next safe point (ADR-0002 §6)
      if (isTerminal(run.state)) return redirect(r, `/runs/${short}?notice=already-ended`);
      const who = await actor();
      const updated = runtime.runs.requestCancel(run.id);
      runtime.events.emit({
        kind: "run.cancel",
        runId: run.id,
        ...(who ? { actor: `${who.kind}:${who.id}` } : {}),
        payload: { immediate: updated.state === "CANCELLED", by: "ui" },
      });
      return redirect(
        r,
        `/runs/${short}?notice=${updated.state === "CANCELLED" ? "cancelled" : "cancel-requested"}`,
      );
    }
    if (m[2] === "resume") {
      // a run nobody moves on (src/app/resumable.ts): the page drives it from now on and resumes it;
      // one parked on a quota window parks again if the window is still full
      const back = (form.get("back") ?? "").startsWith("/knowledge/")
        ? (form.get("back") as string)
        : `/runs/${short}`;
      const sep = back.includes("?") ? "&" : "?";
      if (!resumableOf(runtime, run)) return redirect(r, `${back}${sep}notice=not-waiting`);
      if (!options.launcher) return redirect(r, `${back}${sep}notice=no-launcher`);
      return redirect(r, `${back}${sep}notice=${options.launcher.adopt(run) ? "resumed" : "resuming"}`);
    }
    if (m[2] === "budget") {
      const stop = budgetStopOf(runtime, run);
      if (!stop) return redirect(r, `/runs/${short}?notice=not-waiting`);
      const choice = form.get("choice");
      const more = Number(form.get("amount"));
      if (choice !== "finish" && !(choice === "more" && Number.isInteger(more) && more > 0))
        return redirect(r, `/runs/${short}?notice=amount`);
      if (!budgetGranted(runtime, run.id)) {
        const who = await actor();
        if (!who) return redirect(r, `/runs/${short}?notice=actor`);
        grantBudget(runtime, run, stop, who, choice === "finish" ? { finish: true } : { more }, "ui");
      }
      goOn(run);
      return redirect(r, `/runs/${short}`);
    }
    if (m[2] === "rerun") {
      if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "loop")
        return redirect(r, `/runs/${short}?notice=not-waiting`);
      if (!rerunRequested(runtime, run.id)) {
        const who = await actor();
        if (!who) return redirect(r, `/runs/${short}?notice=actor`);
        // «one more round» of the step the used-up edge went back to — that very step, nothing else
        const back = form.get("back") ?? "";
        const edge = run.waitingFor.detail ?? "";
        requestRerun(runtime, run, who, "ui", back && edge.includes(`->${back}#`) ? back : undefined);
      }
      goOn(run);
      return redirect(r, `/runs/${short}`);
    }
    // decide: only the version the run waits on now, once
    const awaited = run.state === "WAITING_HUMAN" ? awaitedArtifact(runtime, run) : undefined;
    const version = Number(form.get("version"));
    const back = (notice?: string, v = version) =>
      `/runs/${short}/artifacts/${encodeURIComponent(awaited?.type ?? "artifact")}/${encodeURIComponent(awaited?.artifact.name ?? "")}?v=${v}${notice ? `&notice=${notice}` : ""}`;
    if (
      !awaited ||
      awaited.artifact.artifactId !== form.get("artifact") ||
      awaited.artifact.version !== version
    )
      return awaited ? redirect(r, back("stale")) : redirect(r, `/runs/${short}?notice=not-waiting`);
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "request_changes") return redirect(r, back());
    const lines = linesOf(form.get("lines"));
    // the open questions answered on the page: read against the document, not taken from the form
    const questions = openQuestionsOf(runtime.artifacts.text(awaited.artifact));
    const given =
      questions.length > 0
        ? givenFromForm(questions, suggestionsFor(runtime, awaited.artifact), (k) => form.get(k))
        : [];
    const comment = [
      decision === "request_changes" && given.length > 0 ? answersText(given) : "",
      (form.get("comment") ?? "").trim().slice(0, 20_000),
      lines.length > 0 ? `Comments on lines:\n${lines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (decision === "request_changes" && !comment) return redirect(r, back("empty"));
    const who = await actor();
    if (!who) return redirect(r, back("actor"));
    try {
      recordDecision(runtime, run, {
        actor: who,
        artifact: awaited.artifact,
        type: awaited.type,
        decision,
        ...(comment ? { comment } : {}),
        channel: "ui",
      });
    } catch (error) {
      if (!(error instanceof DecisionTakenError)) throw error;
      return redirect(r, back("taken"));
    }
    recordGiven(runtime, awaited.artifact, given, who.id, run.currentStep);
    goOn(run);
    return redirect(r, back());
  };

  // "Resume" starts `jarvis resume` through the launcher; without one, the command to copy stays
  const withResume = <T extends { readonly resumable?: unknown }>(m: T): T => {
    if (options.launcher) return m;
    const { resumable: _gone, ...rest } = m;
    return rest as T;
  };

  const routes = async (r: Request): Promise<void> => {
    const path = r.url.pathname;
    const now = Date.now();
    if (r.req.method === "POST") return post(r);
    if (path === "/") {
      const repoParam = r.url.searchParams.get("repo");
      const all = runtime.runs.list({ includeTerminal: true, limit: 500 });
      const here = options.projectRoot && all.some((x) => x.workspace.repoRoot === options.projectRoot);
      const repo = repoParam === null ? (here ? options.projectRoot : undefined) : repoParam || undefined;
      const q = (r.url.searchParams.get("q") ?? "").slice(0, 200);
      const pageNo = Number(r.url.searchParams.get("page") ?? "1");
      // rows of Recent: the address, else what this browser picked last (a cookie, like the theme)
      const size = Number(r.url.searchParams.get("size") ?? cookieOf(r.req, "jarvis_recent_size") ?? "0");
      const listed = await runsPage(runtime, engine, {
        ...(repo ? { repo } : {}),
        ...(q ? { q } : {}),
        ...(Number.isFinite(pageNo) && pageNo > 1 ? { page: pageNo } : {}),
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
        ...(options.projectRoot ? { current: options.projectRoot } : {}),
        homeDir: options.homeDir,
      });
      const model = { ...listed, waiting: listed.waiting.map(withResume) };
      return page(
        r,
        200,
        {
          title: "Runs",
          page: "runs",
          repos: repoPicker(model),
          ...(model.running.length > 0 ? { tick: 5000 } : {}),
        },
        runsContent(
          model,
          now,
          actions,
          options.launcher && actions
            ? {
                workflows: WORKFLOWS,
                repos: knownRepos(),
                ...(noticeOf(r) ? { notice: noticeOf(r) as Html } : {}),
                ...((repo ?? options.projectRoot)
                  ? { current: (repo ?? options.projectRoot) as string }
                  : {}),
                homeDir: options.homeDir,
                launches: options.launcher
                  .list()
                  .filter((l) => !l.runId && (!repo || l.repoRoot === repo))
                  .map((l) => ({
                    id: l.id,
                    task: l.task,
                    workflow: l.workflow,
                    startedAt: l.startedAt,
                    exitCode: l.exitCode,
                    log: l.log,
                    ...(l.exitCode !== null ? { tail: options.launcher?.tail(l) ?? "" } : {}),
                  })),
              }
            : undefined,
        ),
      );
    }
    if (path === "/knowledge/modules") return modulesPageOf(r);
    if (path === "/knowledge" || path.startsWith("/knowledge/")) return knowledgeGet(r);
    if (path === "/runs/from") return startFrom(r);
    if (path === "/open") return openRef(r);
    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const run = resolveRun(runMatch[1] as string);
      if (!run) return notFound(r, `No run "${runMatch[1]}".`);
      const model = {
        ...withResume(await runPage(runtime, engine, run, { homeDir: options.homeDir })),
        driven: options.launcher?.drives(run.id) === true,
      };
      // a module research: its candidate is decided right here, not only on the Modules page
      const review = await candidateOnRun(run);
      const checkout = await checkoutOn(run);
      const ticking =
        run.state === "RUNNING" ||
        model.card?.kind === "loop" ||
        (model.card?.kind === "clarify" && model.card.thinking);
      return page(
        r,
        200,
        {
          title: `run ${shortRunId(run.id)}`,
          page: "run",
          runId: run.id,
          back: { href: "/", label: "Runs" },
          ...(ticking ? { tick: 3000 } : {}),
        },
        runContent(model, now, actions, noticeOf(r) ?? knowledgeNotice(r), review, checkout),
      );
    }
    const artMatch = /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
    if (artMatch) {
      const run = resolveRun(artMatch[1] as string);
      if (!run) return notFound(r, `No run "${artMatch[1]}".`);
      const v = Number(r.url.searchParams.get("v"));
      const type = decodeURIComponent(artMatch[2] as string);
      const name = decodeURIComponent(artMatch[3] as string);
      const found = artifactPage(runtime, run, type, name, Number.isInteger(v) && v > 0 ? v : undefined);
      const model = found
        ? { ...withResume(found), driven: options.launcher?.drives(run.id) === true }
        : found;
      if (!model) return notFound(r, `Run ${shortRunId(run.id)} has no ${type}/${name}.`);
      const notice = noticeOf(r);
      // a gate reached before answers were prepared (or without them): prepared now, once
      const preparing =
        actions !== undefined &&
        model.awaited &&
        model.questions !== undefined &&
        !model.questions.suggestions
          ? prepareOnce(run, model.artifact)
          : false;
      const extras: ArtifactExtras = {
        ...(actions ? { actions, comments: true } : {}),
        ...(notice ? { banner: notice } : {}),
        ...(preparing ? { preparing } : {}),
      };
      if (type === "implementation") {
        let workflow: ReturnType<LocalWorkflowEngine["workflow"]> | undefined;
        try {
          workflow = engine.workflow(run.workflow);
        } catch {
          workflow = undefined;
        }
        const d = await diffOf(run);
        const t = tryOutOf(runtime, run, {
          ...(workflow ? { workflow } : {}),
          homeDir: options.homeDir,
          changed: (d.files ?? []).map((f) => f.path),
        });
        if (t) Object.assign(extras, { tryOut: t });
        Object.assign(extras, d.files ? { diff: d.files } : {}, d.note ? { diffNote: d.note } : {});
      }
      return page(
        r,
        200,
        {
          title: `${type}/${name}@${model.artifact.version}`,
          page: "artifact",
          ...(preparing ? { tick: 3000 } : {}),
          runId: run.id,
          back: { href: `/runs/${shortRunId(run.id)}`, label: `run ${shortRunId(run.id)}` },
        },
        artifactContent(model, extras),
      );
    }
    if (path === "/models.json") {
      // the header's indicator: answered from the last computed state at once, never computed here
      if (!modelsJson) scheduleHealth(0);
      return send(r, 200, modelsJson ?? PENDING_MODELS, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    if (path === "/waiting.json") {
      // the page's system notifications: the runs that wait for a person, each stop with its own key
      const waiting: Array<{
        id: string;
        task: string;
        workflow: string;
        what: string;
        parked: string | number | undefined;
        terminal: boolean;
        href?: string;
      }> = runtime.runs.list({ state: ["WAITING_HUMAN"], limit: 200 }).map((run) => ({
        id: shortRunId(run.id),
        task: (run.task.split("\n")[0] ?? "").trim().slice(0, 140),
        workflow: run.workflow,
        what: waitingWhat(run),
        parked: parkedAt(runtime, run.id),
        terminal: waitingCard(runtime, run.id) !== undefined,
      }));
      // module research whose candidate waits for a review on the Modules page
      for (const c of candidatesOf(runtime, (run) => run.workflow === "onboard-module")) {
        if (c.decision || !c.doc.module) continue;
        waiting.push({
          id: shortRunId(c.artifact.runId),
          task: `module ${c.doc.module}`,
          workflow: "onboard-module",
          what: "review what the research found",
          parked: c.artifact.artifactId,
          terminal: false,
          href: `/knowledge/modules?path=${encodeURIComponent(c.doc.module)}`,
        });
      }
      return send(r, 200, JSON.stringify({ waiting }), "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    if (path === "/mcp.json") {
      if (!mcpJson) computeMcp();
      return send(r, 200, mcpJson ?? PENDING_MCP, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    const launchAt = /^\/launches\/([0-9a-f]+)$/.exec(path);
    if (launchAt) {
      const launch = options.launcher?.get(launchAt[1] as string);
      if (!launch) return notFound(r, "No such launch (they live as long as this jarvis ui).");
      options.launcher?.tend();
      // the run began: this is its page now
      if (launch.runId) return redirect(r, `/runs/${shortRunId(launch.runId)}`);
      return page(
        r,
        200,
        {
          title: `Starting · ${launch.task.slice(0, 60)}`,
          page: "run",
          back: { href: "/", label: "Runs" },
          // refreshed in place (the header and its popover stay); the run's page once the run begins
          ...(launch.exitCode === null ? { refresh: 2, tick: 2000 } : {}),
        },
        launchContent(
          {
            id: launch.id,
            task: launch.task,
            workflow: launch.workflow,
            startedAt: launch.startedAt,
            exitCode: launch.exitCode,
            log: launch.log,
            tail: options.launcher?.tail(launch, 40) ?? "",
            repo: launch.repoRoot,
          },
          now,
          options.homeDir,
        ),
      );
    }
    if (path === "/live") {
      r.res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      r.res.write("retry: 2000\n\n");
      clients.add(r.res);
      watch();
      r.req.on("close", () => {
        clients.delete(r.res);
        unwatch();
      });
      return;
    }
    return notFound(r, `Nothing at ${path}.`);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    const r: Request = { req, res, url };
    if (!hostOk(req)) return send(r, 403, "403 — unexpected host", "text/plain; charset=utf-8");
    // style and script carry nothing of the runs: no token needed, so the first page loads them
    if (req.method === "GET" && url.pathname === "/assets/app.css")
      return send(r, 200, STYLE, "text/css; charset=utf-8", { "Cache-Control": "no-cache" });
    if (req.method === "GET" && url.pathname === "/assets/app.js")
      return send(r, 200, SCRIPT, "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
    if (url.pathname === "/favicon.ico") return send(r, 204, "", "text/plain");
    const auth = authorized(r);
    if (auth === "no") return send(r, 403, forbiddenPage());
    if (auth === "redirect") {
      // the token leaves the address bar and the history: from now on the cookie carries it
      url.searchParams.delete("t");
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: `${url.pathname}${url.search}`,
        "Set-Cookie": `${cookie()}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
    if (req.method === "POST") {
      // a page of another origin in the same browser cannot post here: its Origin is not ours
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)
        return send(r, 403, "403 — unexpected origin", "text/plain; charset=utf-8");
    } else if (req.method !== "GET")
      return send(r, 405, "405 — method not allowed", "text/plain; charset=utf-8");
    routes(r).catch((error: unknown) => {
      runtime.log.error("ui.error", {
        path: url.pathname,
        message: String((error as Error)?.message ?? error),
      });
      if (res.headersSent) return res.end();
      page(
        r,
        500,
        { title: "Error", page: "error" },
        errorContent(
          500,
          "The page could not be built.",
          "The technical log has the details: jarvis logs --event ui.error",
        ),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${port}/?t=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        if (poller) clearInterval(poller);
        if (tender) clearInterval(tender);
        clearInterval(healthTimer);
        clearInterval(mcpTimer);
        if (mcpChecker) clearInterval(mcpChecker);
        if (healthSoon) clearTimeout(healthSoon);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
