import type { KindChoice } from "../app/taskKind.ts";
import type { TaskKind } from "../core/domain/run.ts";
import { t } from "./i18n.ts";

/** What decided the kind of task: «picked by you», «by the word «bug»», «by the workflow», «by default». */
export function kindWhy(k: KindChoice): string {
  return k.by === "person"
    ? t("picked by you")
    : k.by === "workflow"
      ? t("by the workflow")
      : k.by === "words"
        ? t("by the word «{word}»", { word: k.word ?? "" })
        : t("by default");
}

/** The kind of task in the run's header (run.ts TASK_KINDS). */
export const KIND_NAME: Record<TaskKind, string> = {
  // t("new feature") t("change") t("bug fix") t("refactoring") t("tests") t("docs")
  feature: "new feature",
  change: "change",
  fix: "bug fix",
  refactor: "refactoring",
  test: "tests",
  docs: "docs",
};
