import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { EventSink } from "../telemetry/events.ts";
import { contentRefOf } from "./blobs.ts";
import type { ArtifactStore } from "./store.ts";

/**
 * A person edits an artifact as a file (ADR-0005 §3). The documents meant for it are written into the
 * run's workspace at `.jarvis/runs/<run>/<type>.<ext>`; before a step reads them, and when a person
 * decides at a gate, the file is compared with the version Jarvis wrote there. A changed file becomes
 * the next version with `provenance.kind = human` and a diff against its parent — so an edit is never
 * lost and never passes unrecorded, whichever editor or process made it.
 */
export const EDITABLE_TYPES: readonly string[] = ["spec", "plan", "review"];

/** Event of a recorded edit (ADR-0005 §3). */
export const HUMAN_EDIT_EVENT = "artifact.humanEdit";
/** A changed file that cannot be taken (not valid JSON, or the artifact moved on meanwhile). */
export const HUMAN_EDIT_REJECTED_EVENT = "artifact.humanEditRejected";

/** Kept beside the files: which version each file was written from. */
const MANIFEST = ".versions.json";

interface ManifestEntry {
  readonly artifactId: string;
  readonly version: number;
  readonly contentRef: string;
  /** The content of a rejected edit, so the same rejection is announced once. */
  readonly rejected?: string;
}

type Manifest = Record<string, ManifestEntry>;

export interface EditSync {
  /** Versions made from a person's edit in this pass. */
  readonly edited: readonly ArtifactVersion[];
  readonly rejected: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

export interface EditDeps {
  readonly artifacts: ArtifactStore;
  readonly events: EventSink;
}

/** `<workspace>/.jarvis/runs/<run>`: where a run's editable documents are. */
export function editableDir(run: Pick<Run, "id" | "workspace">): string {
  return join(run.workspace.path, ".jarvis", "runs", run.id);
}

/** `spec.json` for the artifact `spec/spec.json`; another name keeps its type in front of it. */
export function editableName(a: Pick<ArtifactVersion, "type" | "name">): string {
  return a.name.startsWith(`${a.type}.`) ? a.name : `${a.type}-${a.name}`;
}

export function editableFile(run: Pick<Run, "id" | "workspace">, a: Pick<ArtifactVersion, "type" | "name">) {
  return join(editableDir(run), editableName(a));
}

export function isEditable(type: string): boolean {
  return EDITABLE_TYPES.includes(type);
}

function readManifest(dir: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function jsonProblem(a: ArtifactVersion, content: string): string | undefined {
  if (!a.name.endsWith(".json")) return undefined;
  try {
    JSON.parse(content);
    return undefined;
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Equal as documents: an editor that only re-indents or adds the final newline changed nothing. */
function sameDocument(a: ArtifactVersion, before: string, after: string): boolean {
  if (before === after) return true;
  if (!a.name.endsWith(".json")) return before.trimEnd() === after.trimEnd();
  try {
    return JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(after));
  } catch {
    return false;
  }
}

/**
 * One pass: a person's change in a file becomes a version, then every editable artifact's file holds
 * its latest version. Synchronous on purpose — steps of a composite run side by side, and a pass must
 * not interleave with another. Nothing happens when the run's workspace is gone (removed worktree).
 */
export function syncEditable(deps: EditDeps, run: Run, actor: Actor = run.owner): EditSync {
  const latest = EDITABLE_TYPES.flatMap((type) => deps.artifacts.listLatest(run.id, type));
  if (latest.length === 0 || !existsSync(run.workspace.path)) return { edited: [], rejected: [] };
  const dir = editableDir(run);
  mkdirSync(dir, { recursive: true });
  // the files are the run's state, not the change: they never go into its commits (ADR-0003)
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const manifest = readManifest(dir);
  const edited: ArtifactVersion[] = [];
  const rejected: Array<{ file: string; reason: string }> = [];
  for (let a of latest) {
    const name = editableName(a);
    const path = join(dir, name);
    const entry = manifest[name];
    if (entry?.artifactId === a.artifactId && existsSync(path)) {
      const content = readFileSync(path, "utf8");
      const written = deps.artifacts.get(a.artifactId, entry.version);
      const changed =
        contentRefOf(content) !== entry.contentRef &&
        !(written && sameDocument(a, deps.artifacts.text(written), content));
      if (changed) {
        const problem =
          jsonProblem(a, content) ??
          // an agent wrote a newer version while the person edited the older one: theirs is kept aside
          (entry.version !== a.version
            ? `${a.type} moved on to @${a.version} while the file was edited from @${entry.version}`
            : undefined);
        if (problem) {
          const contentRef = contentRefOf(content);
          if (entry.version !== a.version) renameSync(path, `${path}.conflict`);
          if (entry.rejected !== contentRef)
            deps.events.emit({
              kind: HUMAN_EDIT_REJECTED_EVENT,
              runId: run.id,
              actor: `${actor.kind}:${actor.id}`,
              payload: {
                artifactId: a.artifactId,
                version: a.version,
                type: a.type,
                file: name,
                reason: problem,
              },
            });
          rejected.push({ file: name, reason: problem });
          if (entry.version === a.version) {
            // the person fixes the file; Jarvis does not write over it
            manifest[name] = { ...entry, rejected: contentRef };
            continue;
          }
        } else {
          const result = deps.artifacts.recordHumanEdit(
            a.artifactId,
            content,
            actor,
            `edited in .jarvis/runs/${run.id}/${name}`,
          );
          if (result.changed) {
            a = result.artifact;
            edited.push(a);
            const diffRef = a.provenance.kind === "human" ? a.provenance.diffRef : undefined;
            deps.events.emit({
              kind: HUMAN_EDIT_EVENT,
              runId: run.id,
              ...(a.stepId ? { stepId: a.stepId } : {}),
              actor: `${actor.kind}:${actor.id}`,
              payload: {
                artifactId: a.artifactId,
                version: a.version,
                parentVersion: a.parentVersion,
                type: a.type,
                name: a.name,
                file: name,
                ...(diffRef ? { diffRef } : {}),
              },
            });
          }
        }
      }
    }
    const current = existsSync(path) ? contentRefOf(readFileSync(path)) : undefined;
    if (current !== a.contentRef) writeFileSync(path, deps.artifacts.content(a));
    manifest[name] = { artifactId: a.artifactId, version: a.version, contentRef: a.contentRef };
  }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { edited, rejected };
}

/** "edited by <who>" for a version a person made, else undefined. */
export function editedBy(a: Pick<ArtifactVersion, "provenance">): string | undefined {
  return a.provenance.kind === "human" ? (a.provenance.actor.display ?? a.provenance.actor.id) : undefined;
}
