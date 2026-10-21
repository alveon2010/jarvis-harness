# ADR-0020: Skills, Standards и инженерное знание как типизированные сущности

- Статус: принято; §6 реализован (кандидаты из review, вручную и из повторяющихся findings)
- Дата: 2026-10-03
- Сделано: решение по любым кандидатам в `jarvis ui` — карты модулей на Knowledge → Modules, остальные
  на Knowledge → Candidates
- Основание: [ADR-0001](0001-target-architecture.md) §7 (контекст агентов), §9 (знания проекта);
  концепция «Jarvis Skills, Standards & Engineering Knowledge» (2026-10-03). Опирается на
  [ADR-0005](0005-artifact-versions-provenance.md) (provenance), [ADR-0012](0012-evals-and-record-replay.md)
  (evals), [ADR-0013](0013-context-pressure-and-prefix-cache.md) (слои контекста, бюджет),
  [ADR-0015](0015-semantic-retrieval.md) (отбор знаний), [ADR-0019](0019-human-collaboration.md) §5
  (кандидаты из review), [ADR-0021](0021-stack-agnostic-core.md) (теги стека для `appliesTo`)
- Код (план): `src/knowledge/{standards,skills,package,resolver,candidates}.ts`,
  `src/agents/context.ts` (слой L4 → EngineeringContextPackage), проверка стандартов в composite `verify`,
  CLI `jarvis standards list|check`, `jarvis skills list`, `jarvis candidates add|list|show|promote|reject`;
  кандидаты вне шагов — `src/app/candidates.ts` (`addCandidate`, `candidatesRunOf`),
  `src/app/repeatedFindings.ts`

## Контекст

Сегодня знание проекта — плоский слой L4: все `.jarvis/knowledge/*.md` попадают в каждый вызов агента,
обрезанные по бюджету. Это не масштабируется (бюджет делится поровну между документами, независимо от
релевантности), не проверяется (стандарт «persistence только через repository» — просто текст, который
агент может проигнорировать) и не версионируется в provenance результата. Инструкции агентов
(`.jarvis/agents/<id>.md`) переопределяют агента целиком, а не добавляют знание «как делать конкретный
тип изменения».

Нужно разделить **что известно** (Knowledge), **что обязательно** (Standard), **как делать** (Skill)
и **что разрешено** (Policy — уже есть: ADR-0010, 0016, tool policy), и отбирать их под задачу.

## Решение

### 1. Сущности

| Сущность | Вопрос | Хранение | Версия |
| --- | --- | --- | --- |
| Knowledge | что известно о проекте | `.jarvis/knowledge/*.md` | по содержимому (blobSha) |
| Standard | какое правило обязательно/рекомендовано | `.jarvis/standards/<id>.md` (front-matter + текст) | `version` в front-matter |
| Skill | как выполнять тип инженерной работы | `.jarvis/skills/<id>/{skill.yaml,instructions.md}` | `version` в `skill.yaml` |
| Policy | что разрешено | конфиг (ADR-0014/0016), tool policy | — |
| Tool, Agent | чем и кто | реестры (этапы 4–5) | — |

Standard:

```yaml
id: STD-BACKEND-PERSISTENCE-01
version: 2
title: Persistence only through repositories
scope: { stacks: [csharp, aspnet], paths: ["src/**/Application/**"] }
severity: required          # required | recommended
verification:
  kind: hybrid              # deterministic | semantic | hybrid
  check:                    # обязателен для deterministic/hybrid
    pattern: { glob: "src/**/Application/**/*.cs", mustNot: "DbContext" }
    # либо: tool: project.lint, args: {...}, expect: { exitCode: 0 }
source: { kind: adr, ref: "docs/adr/0007-persistence.md" }
tags: [persistence, architecture]
```

Skill:

```yaml
id: aspnet-endpoint-change
version: 1
appliesTo: { stacks: [aspnet], kinds: [feature, change], paths: ["src/**/Api/**"] }
inputs: [spec, plan]
outputs: [implementation]
requiredCapabilities: [project.build, project.test, code.findReferences?]
requiredStandards: [STD-ASPNET-*, STD-BACKEND-PERSISTENCE-01]
verification: [project.build, project.test]
evals: [evals/aspnet-endpoint-change/*.yaml]
```

`instructions.md` — процедура для агента. Skill не содержит стековых условий внутри; выбор стека делает
резолвер (§3), один skill — одна комбинация.

### 2. Привязка детерминированных проверок

`verification.kind: deterministic|hybrid` без `check` — ошибка загрузки стандарта. `check` — одно из:

- `pattern` — `glob` + `must` / `mustNot` (regex), выполняется ReviewCollector-подобным сканером по
  diff и затронутым файлам; детерминирован, не требует стека;
- `tool` — вызов capability-инструмента (`project.lint`, `project.format`, `code.diagnostics`, ADR-0021
  §4) с ожидаемым результатом.

Детерминированные проверки входят в composite-шаг `verify` после `implementation`: нарушение
`required` → outcome `standards_violation` с `reasons` (`standard@version`, файл, строка) и обратное
ребро в `implementation`; нарушение `recommended` → finding в контексте review. Семантические стандарты
передаются ReviewAgent как чеклист; его результат содержит `standardsChecked[]`.

### 3. Резолвер и EngineeringContextPackage

Перед вызовом агента `knowledge/resolver.ts` строит пакет:

```
EngineeringContextPackage
  task:         {kind, affectedPaths}            ← impact артефакт (или spec до impact)
  stack:        ProjectCapabilities              ← ADR-0021 §3
  skills[]:     отобранные по appliesTo, ≤ human.context.maxSkills (по умолчанию 2)
  standards[]:  по scope ∩ (stacks, paths) + requiredStandards выбранных skills
  knowledge[]:  по тегам/путям; позже — ADR-0015 семантический отбор
  provenance:   [{id, version, blobSha}] для всего пакета
```

Отбор детерминирован (сортировка по специфичности scope, затем id); при одинаковых входах — тот же
пакет, поэтому prefix cache (ADR-0013) сохраняется между tool-раундами шага.

Пакет заменяет слой L4 в `agents/context.ts`. Порядок и приоритет слоёв в промпте:

```
L0 система/политики (неизменяем)
L1 задача, инструкции агента, контракт результата
L2 состояние (итерация, причины повтора)
L3 входные артефакты
L4 EngineeringContextPackage:
     skills (процедура)  >  standards (required, затем recommended)  >  knowledge
L5 история инструментов
```

Конфликт между процедурой skill и инструкцией агента решается в пользу инструкции агента; между skill
и standard — в пользу standard (`required`). Это записано в L0.

Бюджет L4 остаётся 30 % окна (ADR-0013); распределение — skills 40 %, standards 35 %, knowledge 25 %;
не поместившиеся элементы перечисляются по id как «доступно по запросу» (инструмент `knowledge.read`).

### 4. Provenance

Артефакт результата агента получает в `sourceRefs` все `standard@version`, `skill@version`,
`knowledge#blobSha` из пакета (ADR-0005). `jarvis status` показывает, по каким стандартам проверялся
шаг; evals (ADR-0012) сравнивают результат при разных версиях skill.

### 5. Проектный и пользовательский уровни

Поиск: `.jarvis/standards`, `.jarvis/skills` проекта; затем `~/.jarvis/{standards,skills}` пользователя
только для `recommended`-стандартов и skills с `scope: personal` — пользователь не может добавить
проекту `required`-стандарт или ослабить его (narrow-only, как ADR-0014). Встроенные skills Jarvis
(generic: `sdd-implementation`, `unit-testing`, `refactor`) — в пакете, переопределяются проектными по `id`.

### 6. Кандидаты и продвижение

Единый артефакт `candidate` с `kind ∈ {knowledge, standard, skill-improvement}` создаётся:

- ReviewAnalysisAgent'ом (ADR-0019 §5) из комментариев `KNOWLEDGE_CANDIDATE`;
- детерминированно, без модели, из повторяющегося finding review: одинаковый `issue` в ≥ 2 Run;
- человеком вручную: `jarvis candidates add` или форма «Предложить кандидата» на обзоре Knowledge в
  `jarvis ui`.

**Где живёт кандидат не из шага.** Артефакт принадлежит Run, поэтому для кандидатов, которые не сделал
ни один шаг (ручные и из повторяющихся findings), у репозитория есть один служебный Run с workflow
`candidates`: создаётся при первом таком кандидате и сразу завершается (`COMPLETED` — исполнять нечего).
Так `list|show|promote|reject`, решения (approvals) и provenance работают без изменений; отдельное
хранилище кандидатов или «висящие» артефакты без Run потребовали бы второго пути для всего этого.
Отвергнутые варианты: класть ручного кандидата в последний Run (чужой прогон получает чужой артефакт,
а `jarvis forget` того прогона удалит и кандидата) и Run на каждого кандидата (шум в списке прогонов).

**Ручной кандидат** — `jarvis candidates add <kind> <title> [text…]`: `kind ∈ {standard, knowledge,
skill-improvement}`; текст — аргументом, `--file` или из stdin; `--path` (повторяемый), `--evidence`
(повторяемый), `--why`. Для `skill-improvement` обязателен `--skill <id>`: скилл должен существовать и
быть редактируемым проектом (проектный или встроенный — как при promote, который дописывает шаг в его
`instructions.md` и поднимает версию); иначе кандидат не создаётся. Provenance — `human` с актором.

**Кандидат из повторяющегося finding.** После каждого шага, выдавшего артефакт `review`, движок берёт
findings всех версий review этого Run и ищет тот же `issue` в review других Run того же репозитория.
Сравнение — по стабильному ключу: текст в нижнем регистре без цитат (`code`, "…", «…»), путей и имён
файлов, `line N`/`:N`, чисел, пунктуации и служебных слов; оставшиеся слова — по разу, отсортированные
(порядок слов не важен); ключ — sha256 от этого. Меньше трёх слов — не сравнивается (слишком мало,
чтобы отличить одно замечание от другого). Ключ в ≥ 2 разных Run (раунды одного review — один Run)
даёт **одного** кандидата `standard` (`finding-<key>.json` в Run кандидатов): заголовок — формулировка
issue, текст — `suggestion` и сам issue, `evidence` — места (`file:line`) и ссылки на версии review,
`finding.runs` — прогоны. При promote пишется `severity: recommended`, `verification: semantic`. Новый
Run с тем же ключом добавляет свои места и прогон к открытому кандидату (новая версия артефакта);
решённого (принят или отвергнут) повтор не трогает. Ошибка здесь не останавливает Run — пишется в лог
`candidates.repeated`.

Кандидат содержит `evidence[]` (ссылки на Run, артефакты, комментарии). Продвижение — только человеком:
`jarvis candidates promote <id>` создаёт/обновляет файл стандарта или skill в worktree (новая версия,
коммит с трейлером `Jarvis-Kind: knowledge-promotion`) и проходит обычный code review репозитория.
Автоматическое продвижение не предусмотрено. Отключать создание кандидатов настройкой не стали:
`human.review.knowledgePromotion` убран в пилоте как ненужный (ADR-0019 §9).

### 7. Границы пилота

В пилоте: ручные standards и skills, резолвер по `scope`/`appliesTo`, пакет в контексте, `pattern`- и
`tool`-проверки в `verify`, provenance, `candidate` из review с ручным продвижением. Позже: генерация
skills из успешных Run, семантический отбор knowledge (ADR-0015), evals на skills по умолчанию, скоринг
качества стандартов по статистике нарушений.

## Последствия

- `.jarvis/knowledge` сохраняется как есть; standards и skills — новые каталоги, появляются постепенно.
- Контекст агента становится адресным и проверяемым: что было в пакете — видно в provenance.
- `verify` получает детерминированные проверки стандартов без участия модели.
- Цена: схема front-matter, резолвер, сканер `pattern`, миграция L4; покрывается unit-тестами на
  детерминированность отбора и e2e `sdd` с нарушением стандарта.

## Альтернативы

- **Один большой `CONVENTIONS.md`.** Не отбирается по задаче, не проверяется, не версионируется в
  provenance — текущая ситуация.
- **Standards как lint-правила только.** Теряется семантическая часть (архитектурные правила), которую
  linter не выразит; оставлены оба вида с явным `verification.kind`.
- **Skills как отдельные агенты на каждый тип изменения.** Взрыв числа агентов и workflow; агент остаётся
  общей ролью, специализация — через пакет (ADR-0021 §5).
- **Автоматическое продвижение знаний из review.** Случайный комментарий становится глобальной
  конвенцией; отвергнуто, продвижение только через человека.
