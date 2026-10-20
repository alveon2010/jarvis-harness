# Evals (ADR-0012)

Workflow-уровневые проверки: задача на fixture-репозитории проходит весь `sdd` с автоматически
утверждёнными гейтами, результат сравнивается с «золотом». Нужны, чтобы менять промпты, модели,
навыки и стандарты и видеть, стало ли лучше — в успехах на 10 000 выходных токенов, а не в ощущениях.

## Структура

```
evals/
  <suite>/
    <case>/
      case.yaml
      fixture/            # репозиторий-образец (без .git; инициализируется при прогоне)
      cassette/           # записанные ответы модели (режим record → replay)
  results/<date>-<suite>.json
  baseline/<suite>.json
```

```yaml
# case.yaml
id: onboarding-restart
task: "ABC-42 allow onboarding restart after rejection"
workflow: sdd
fixture: fixture
project:                      # накладывается на .jarvis/project.yaml fixture
  tools: { local: { tests: "node --test" } }
gold:
  files: [src/onboarding.ts]                   # файлы, которых должна коснуться реализация
  tests: "node --test"                         # команда, которая должна пройти после
  acceptance: ["REJECTED", "once"]             # фразы в критериях приёмки спецификации
  requiredSources: ["src/onboarding.ts"]       # источники, которые research/impact обязаны процитировать
cassette: cassette
maxApprovals: 6
source: { run: run_…, task: ABC-42 }           # для кейсов из run-to-case
```

## Набор `regressions` в репозитории

`evals/regressions/` — кейсы по образцу багов из пилота, обезличенные: своя маленькая фикстура вместо кода
команды. `compact-form-fields` — общая функция не учитывает режим формы, и компактная форма показывает блок,
который нужен только полной (workflow `fix`). Его `gold.tests` проверяет сам баг, а не только тесты
фикстуры. Кассета записывается один раз на машине с доступом к модели и коммитится: в ней только фикстура
и ответы модели. После этого изменения движка, инструментов и разбора ответов проверяются без шлюза:

```sh
jarvis evals run --suite regressions --mode record   # один раз, живая модель
jarvis evals run --suite regressions                 # replay
jarvis evals baseline regressions && jarvis evals diff regressions
```

Промпты, навыки и пороги так не проверить: их изменение меняет ключи кассеты, и replay даёт промах. Для них
нужна новая запись (`--mode record` или `live`), и её сравнение с baseline показывает эффект правки.

## Прогон

```sh
jarvis evals run --mode record            # набор default: живые модели, ответы пишутся в кассету
jarvis evals run                          # replay — детерминированно, без сети
jarvis evals run --mode live --variant knowledge.maxSkills=3   # значение: строка, число, true/false
jarvis evals run --suite regressions --out evals/results/manual.json
```

Без `--suite` берётся набор `default` (`evals/default/`); `--suite` — имя набора или путь к папке.

`--variant k=v` накладывает переопределения конфигурации на каждый кейс (сравнение моделей,
`knowledge.maxSkills`, порогов контекста). В `replay` без кассеты для запроса — ошибка кейса, а не
обращение к модели.

## Метрики

| Метрика | Что |
|---|---|
| `state` | конечное состояние run |
| `testsPassed` | `gold.tests` в workspace после run |
| `fileRecall` | доля `gold.files`, которых коснулась реализация |
| `acceptanceCoverage` | доля `gold.acceptance`, присутствующих в критериях приёмки spec |
| `answersCoverage` | доля ответов человека из `gold.answers`, которые отражены в спеке прогона (правило ниже) |
| `sourceRecall` | доля `gold.requiredSources`, процитированных research/impact |
| `loops` | число возвратов по обратным рёбрам |
| `outputTokens`, `promptTokens`, `modelCalls`, `ms` | стоимость |
| `success` | `COMPLETED` и все заданные recall/coverage = 1 и тесты прошли (`answersCoverage` — только если у кейса есть ответы, которые можно проверить) |
| `successPer10k` | success / (outputTokens / 10 000) — главная цифра |

Сводка по suite: `successRate`, `meanFileRecall`, `meanAcceptanceCoverage`, `meanAnswersCoverage` (по кейсам
с ответами; нет таких — поля нет), `successPer10k`.

**Как считается `answersCoverage`** (`src/evals/answers.ts`, без модели). Спека и ответ нормализуются: NFKC,
нижний регистр, `ё` → `е`, всё, что не буква и не цифра, — один пробел. Ответ отражён, если спека содержит его
целиком (по границам слов). Иначе считаются ключевые слова ответа: слова от четырёх букв или с цифрой, кроме
служебных («that», «should», «нужно», «чтобы»…). Слово найдено, если какое-то слово спеки начинается с его основы —
первых `длина − 2` символов, но не меньше 4 и не больше 6 (`attempts` → `attemp`, `попытки` → `попыт`), так что
падежи и множественное число совпадают; слово с цифрой ищется как есть («5» — не «3»). Ответ отражён, если найдены
не меньше трёх четвертей его ключевых слов. Ответ без ключевых слов («да», «ok») проверить не на чем — он не
считается; если у кейса таких только, метрики нет.

## Базовая линия и регрессии

```sh
jarvis evals baseline                         # зафиксировать последний результат
jarvis evals diff --tolerance 0.05            # ненулевой код при падении больше 5 %
```

`diff` сравнивает `successRate`, `meanFileRecall`, `meanAcceptanceCoverage`, `meanAnswersCoverage` (если она есть
в обоих результатах — у baseline до неё её нет) и `successPer10k`; допуск —
`max(tolerance·|baseline|, tolerance)`. `evals run` выходит с кодом 1, если хоть один кейс не успешен. Удобно в CI
после изменения промптов или навыков.

## Кейс из реального run

```sh
jarvis evals run-to-case <run> --id onboarding-restart     # в evals/default/
```

Fixture — базовый коммит run: в наборе внутри того же репозитория ссылкой (`fixture: { commit: <sha>, overlay: overlay }`,
раннер распаковывает коммит через `git archive` и кладёт поверх `overlay/` — `.jarvis/` прогона; кейс весит килобайты,
пилот: 4,3 МБ копии сервиса), в наборе снаружи — копией в `fixture/`; gold: `files` — файлы, которые run изменил (git diff),
`acceptance` — из `requirements[].acceptance` в spec, обязательные источники — только из версий spec/impact/research,
которые правил человек; id по умолчанию — ключ задачи (или её первые слова) и короткий id прогона; тестовую
команду из `tools.local.test|tests|check`; записывает `source` для трассируемости. `--no-fixture` —
только `case.yaml`. Кассету для replay нужно записать отдельным `--mode record`.

Ещё `run-to-case` кладёт в `gold.answers` ответы человека на открытые вопросы документов (со страницы одобрения;
по ним считается `answersCoverage`). В `overlay/` он кладёт те файлы `.jarvis/project.yaml` и
`.jarvis/knowledge`, которых нет в базовом коммите или которые с ним расходятся. Берутся они такими, какими были на
старте прогона, а не какими стали в рабочей копии потом. Прогон при старте сохраняет их в объектное хранилище git
(`git hash-object -w`), а id пишет в событие `run.created`. Модуль, принятый после прогона, или правка `project.yaml`
в кейс не попадут. Для прогонов, запущенных до этого изменения, берётся рабочая копия без файлов, изменённых после
начала прогона; их список печатается («not in the overlay»). Закоммиченный и неизменённый `.jarvis` — пустой
overlay. (Набор вне репозитория — копия фикстуры с `.jarvis` рабочей копии.)

**Сервис репы знаний (ADR-0025 §5).** Кейсы сервиса живут в репе знаний: `evals/<набор>/` там, в сервис ничего
не пишется (`--suite` по имени и `evals run` в сервисе тоже берут `evals/` репы знаний). Fixture:

```yaml
fixture:
  service: orders-api
  commit: <sha сервиса>          # базовый коммит прогона
  knowledge:
    commit: <sha репы знаний>     # как прогон её застал (run.created → knowledgeRepo)
    overlay: overlay              # её файлы, изменённые на старте: knowledge/services/<сервис>/…, .jarvis/…
```

Раннер собирает песочницу из двух реп рядом: репа знаний на своём коммите с `overlay/` и сервис на своём —
репа сервиса берётся там, где её держит карта этой машины. В песочнице карта указывает на папку сервиса, личные
`knowledgeRepo` и `repos` не читаются (кейс не дотянется до настоящих реп). `project` кейса и `--variant`
ложатся в `services.<сервис>`. Тестовая команда кейса — сервиса (`services.<сервис>.tools.local`).

**Из `jarvis ui`.** На странице завершённого прогона с принятой реализацией — карточка «Keep it as an eval case»:
набор (по умолчанию `default`) и **Make an eval case** — то же, что `jarvis evals run-to-case <run> --suite <набор>`,
кейс ложится в `evals/<набор>/` репозитория. После — «✓ eval case» с путём и командой записи кассеты.

## Кандидаты в кейсы

Не каждый принятый прогон стоит кейса: прошедший напрямую проверяет мало. Когда прогон с принятой реализацией
заканчивается `COMPLETED`, Jarvis смотрит, научился ли он на нём чему-то, и если да — пишет событие
`evals.candidate` с причинами (`src/evals/candidates.ts`). Причины:

- человек вернул документ на гейте (`request_changes`) — «spec sent back 2×»;
- сработало обратное ребро, не то, по которому шёл возврат, — «back edge review->implementation#changes 1×»;
- человек правил spec, research или impact (версии с provenance `human`) — «spec edited by a person (v3)».

Файлы кейса сами не пишутся: кейс содержит контекст проекта и требует взгляда человека. Прогоны самих evals
(`evals@jarvis`) кандидатами не бывают.

```sh
jarvis evals candidates                  # открытые кандидаты, у каждого — почему
jarvis evals run-to-case <run>           # сделать кейс (кандидат уходит из списка)
jarvis evals candidates --dismiss <run>  # не кейс: убрать из списка
```

В `jarvis ui` кандидаты — группа «Worth keeping as eval cases» на странице Runs, а карточка «Keep it as an eval case»
на странице прогона говорит, почему его стоит оставить (или что он прошёл напрямую).

## Evals по расписанию

Живые evals прогоняет daemon (`jarvis daemon`) по расписанию из конфигурации — личной (`~/.jarvis/config.yaml`) или
проекта — и только на моделях своего пула квот, чтобы не съедать интерактивную квоту команды:

```yaml
quotaPools:
  evals: { window: { minutes: 1440, kind: sliding }, limits: { outputTokens: 200000 } }
models:
  flash-evals: { …, quotaPool: evals }     # отдельный ключ/деплой под evals
evals:
  schedule:                                 # одно расписание или список
    suite: regressions                      # имя набора или путь
    every: 24h                              # или cron: "30 3 * * *" (местное время машины)
    mode: live                              # по умолчанию live
    pool: evals                             # обязателен; неизвестный пул — ошибка конфигурации
    tolerance: 0.05                         # допуск diff
```

Когда расписание подошло (`every` — период после прошлого запуска, никогда не запускалось — сразу; `cron` — первая
названная минута после прошлого запуска), daemon после возобновления прогонов запускает набор: у ролей остаются
только модели пула `pool`, прочие модели убираются (роль без модели пула — ошибка кейса, а не трата чужого пула).
Результат — `evals/results/<date>-<suite>.json`, сравнение — с `evals/baseline/<suite>.json`, итог — событие
`evals.scheduled`. Регресс или незапуск — строка на странице Runs с командой `jarvis evals diff <suite>`.

```sh
jarvis evals schedule      # расписания: последний прогон (итог), следующий
```
