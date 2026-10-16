import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ConfigError, zodIssues } from "../core/config/errors.ts";
import {
  StepDefinitionSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "../core/domain/workflow.ts";
import { layoutOf } from "../core/paths.ts";
import { BUILTIN_WORKFLOWS } from "./builtin.ts";

export function parseWorkflow(text: string, source: string): WorkflowDefinition {
  const raw: unknown = YAML.parse(text);
  const result = WorkflowDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `invalid workflow definition (${source})`,
      zodIssues(result.error).map((i) => ({ ...i, source })),
    );
  }
  return result.data;
}

/** Built-in workflows, overridden by `<project>/.jarvis/workflows/*.yaml` with the same name. */
export function loadWorkflows(projectRoot?: string): Map<string, WorkflowDefinition> {
  const map = new Map<string, WorkflowDefinition>();
  for (const [name, text] of Object.entries(BUILTIN_WORKFLOWS))
    map.set(name, parseWorkflow(text, `builtin:${name}`));
  if (projectRoot) {
    const dir = join(layoutOf(projectRoot).jarvisDir, "workflows");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()) {
        const path = join(dir, file);
        const wf = parseWorkflow(readFileSync(path, "utf8"), path);
        map.set(wf.name, wf);
      }
    }
    // a service of a knowledge repository: sdd checks after its impact whether the task reaches other
    // services (ADR-0025 §7); a repository of its own keeps sdd exactly as it is
    if (layoutOf(projectRoot).meta?.service) {
      const sdd = map.get("sdd");
      if (sdd) map.set("sdd", withScope(sdd));
    }
  }
  return map;
}

/** `impact → scope → <what came after impact>`: the scope step inserted, unless the workflow has one or no impact. */
export function withScope(wf: WorkflowDefinition): WorkflowDefinition {
  const at = wf.steps.findIndex((s) => s.id === "impact");
  const impact = wf.steps[at];
  if (!impact || wf.steps.some((s) => s.id === "scope")) return wf;
  const scope = StepDefinitionSchema.parse({
    id: "scope",
    kind: "deterministic",
    tool: "scope.check",
    outputs: ["scope"],
    transitions: { onSuccess: impact.transitions.onSuccess },
  });
  const steps = [...wf.steps];
  steps[at] = { ...impact, transitions: { ...impact.transitions, onSuccess: "scope" } };
  steps.splice(at + 1, 0, scope);
  return { ...wf, steps };
}
