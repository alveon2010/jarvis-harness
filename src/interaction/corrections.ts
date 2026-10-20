import type { Runtime } from "../app/runtime.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";

/**
 * `requirement-correction` (ADR-0019 §4, §5): what a person corrected in the requirements — in a
 * clarification thread (its accepted resolution names the requirements it changes) or in a review
 * (a comment review-analysis classed REQUIREMENT_CORRECTION). An artifact of its own, provenance
 * `human`, made against the latest `requirements`: the `requirements` step takes it as input when it
 * runs again and writes the next version of the requirements; every later step reads it as binding.
 */
export const REQUIREMENT_CORRECTION = "requirement-correction";

export interface RequirementCorrectionDoc {
  readonly from: "clarification" | "review";
  /** The clarification or the review package it came from (`artifactId@version`). */
  readonly source?: string;
  /** The requirements version it corrects (`artifactId@version`), when the run has one. */
  readonly basedOn?: string;
  readonly corrections: readonly string[];
  /** The rule the clarification settled, if it came from one. */
  readonly rule?: string;
  readonly by: string;
}

/** Records the person's corrections; nothing when there are none. */
export function recordRequirementCorrection(
  runtime: Runtime,
  run: Run,
  input: {
    readonly from: RequirementCorrectionDoc["from"];
    /** Names the artifact: one per thread or review session, a new version when it changes. */
    readonly key: string;
    readonly source?: string;
    readonly corrections: readonly string[];
    readonly rule?: string;
    readonly by: string;
    readonly stepId: string;
    readonly iteration: number;
  },
): ArtifactVersion | undefined {
  const corrections = input.corrections.map((c) => c.trim()).filter(Boolean);
  if (corrections.length === 0) return undefined;
  const requirements = runtime.artifacts.listLatest(run.id, "requirements")[0];
  const basedOn = requirements ? `${requirements.artifactId}@${requirements.version}` : undefined;
  const doc: RequirementCorrectionDoc = {
    from: input.from,
    ...(input.source ? { source: input.source } : {}),
    ...(basedOn ? { basedOn } : {}),
    corrections,
    ...(input.rule ? { rule: input.rule } : {}),
    by: input.by,
  };
  const artifact = runtime.artifacts.put({
    runId: run.id,
    type: REQUIREMENT_CORRECTION,
    name: `${input.key}.json`,
    content: JSON.stringify(doc, null, 2),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: input.by, verified: false } },
    sourceRefs: [input.source, basedOn].filter((r): r is string => r !== undefined),
    stepId: input.stepId,
    iteration: input.iteration,
  });
  runtime.events.emit({
    kind: "requirements.corrected",
    runId: run.id,
    stepId: input.stepId,
    payload: {
      artifact: `${artifact.artifactId}@${artifact.version}`,
      from: input.from,
      corrections: corrections.length,
    },
  });
  return artifact;
}

/** The run's requirement corrections, oldest first, as documents. */
export function requirementCorrectionsOf(
  runtime: Runtime,
  runId: string,
): Array<{ artifact: ArtifactVersion; doc: RequirementCorrectionDoc }> {
  const out: Array<{ artifact: ArtifactVersion; doc: RequirementCorrectionDoc }> = [];
  for (const artifact of runtime.artifacts.listLatest(runId, REQUIREMENT_CORRECTION)) {
    try {
      const doc = JSON.parse(runtime.artifacts.text(artifact)) as RequirementCorrectionDoc;
      if (Array.isArray(doc.corrections)) out.push({ artifact, doc });
    } catch {
      // not JSON
    }
  }
  return out.sort((a, b) => a.artifact.createdAt.localeCompare(b.artifact.createdAt));
}
