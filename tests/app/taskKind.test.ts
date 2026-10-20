import { describe, expect, it } from "vitest";
import { kindOfTask, kindOfWords } from "../../src/app/taskKind.ts";

describe("the kind of a task", () => {
  it("the words decide it, the same in English and Russian", () => {
    const said = (task: string) => kindOfWords(task);
    expect(said("Сумма заказа не сохраняется")).toEqual({ kind: "fix", word: "не сохраняется" });
    expect(said("Fix the cart crash")?.kind).toBe("fix");
    expect(said("Рефакторинг модуля оплаты")?.kind).toBe("refactor");
    expect(said("Добавить тесты на корзину")).toEqual({ kind: "test", word: "добавить тесты" });
    expect(said("Add unit tests for the cart")?.kind).toBe("test");
    expect(said("Обновить README")?.kind).toBe("docs");
    expect(said("Новая страница профиля")?.kind).toBe("feature");
    // a word, not a part of one: «address» is not «add»
    expect(said("the address book")).toBeUndefined();
    expect(said("ABC-142")).toBeUndefined();
  });

  it("the person's pick, then the workflow's kind, then the words, then change", () => {
    expect(kindOfTask({ task: "Ошибка в корзине", picked: "refactor", workflowKind: "fix" })).toEqual({
      kind: "refactor",
      by: "person",
    });
    expect(kindOfTask({ task: "Новая страница", workflowKind: "fix" })).toEqual({
      kind: "fix",
      by: "workflow",
    });
    expect(kindOfTask({ task: "Ошибка в корзине" })).toEqual({ kind: "fix", by: "words", word: "ошибка" });
    expect(kindOfTask({ task: "ABC-142" })).toEqual({ kind: "change", by: "default" });
  });
});
