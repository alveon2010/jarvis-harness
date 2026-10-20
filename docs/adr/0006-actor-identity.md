# ADR-0006: Идентичность актора в Run и audit trail

- Статус: принято; §2–4 сделаны: `actor` и `onBehalfOf` у событий (контекст исполнения,
  `src/telemetry/events.ts`), daemon — `service:daemon` от имени владельца, CI — `JARVIS_ON_BEHALF_OF`,
  `daemon.actAsOwner`, «от имени» в ленте прогона
- Не сделано: `agentId` отдельным полем события (он в payload `model.call`); `actor` в таблице `effects` —
  кто исполнил эффект, видно по его событиям `effect.*` и артефакту `pull-request`
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §3 (переход к shared runtime), §13 («каждый tool call
  имеет run/agent identity и audit trail», «credentials и MCP auth никогда не передаются модели»);
  [ADR-0002](0002-run-effects-and-lease.md) §5 (`--steal` пишется с актором), [ADR-0005](0005-artifact-versions-provenance.md)
  §3–4 (правки и approvals человека)
- Код (план): `src/core/actor.ts`, `src/security/credentials.ts` (разрешение credentials по актору),
  `src/telemetry/events.ts` (поле `actor` во всех событиях), резолвер актора в `src/cli/context.ts`

## Контекст

ADR-0001 описывает identity в audit trail как `run/agent`, но не как «кто». Для local-first это
неважно — пользователь один. Но §3 прямо планирует shared runtime с корпоративным backend, и там первый
вопрос аудита — «кто запустил, кто одобрил, от чьего имени ушёл комментарий в Jira». Добавить актора потом —
значит мигрировать схему Run, approvals, effects и все экспортированные traces. Поле дешевле заложить
сейчас, даже если его значение всегда одно.

## Решение

### 1. Модель

```
Actor
  |- kind:      user | service | ci
  |- id         user: email или корпоративный subject; service: "daemon"; ci: "<system>:<pipelineId>"
  |- display    для CLI/отчётов
  `- verified   false — self-asserted (local), true — подтверждён backend/SSO (shared runtime)
```

### 2. Где присутствует

| Сущность | Поля |
| --- | --- |
| `Run` | `owner` — актор, создавший Run |
| каждое событие telemetry (model call, tool call, effect, approval, loop, checkpoint) | `actor`, `onBehalfOf?`, `agentId?` |
| `approvals`, `effects`, `artifact.provenance.human`, `lock_owner` при `--steal` | `actor` |

`onBehalfOf` появляется, когда действие выполняет не владелец: daemon резюмирует Run — `actor =
service:daemon`, `onBehalfOf = run.owner`; CI — `actor = ci:…`, `onBehalfOf` — автор коммита/PR, если
известен.

### 3. Как определяется

Порядок: `JARVIS_ACTOR` (env, для CI и скриптов) → `~/.jarvis/config.yaml: actor` → `git config user.email`
проекта → отказ (`jarvis doctor` объясняет, что задать). Всё это `verified: false`. При появлении
корпоративного backend актор получает `verified: true` от него, и локальные источники используются только
как `display`.

### 4. Credentials принадлежат актору

MCP- и git-credentials хранятся в keychain/credential helper пользователя и разрешаются Tool Router'ом по
`actor` в момент вызова — на транспортном уровне, в аргументы инструмента и в контекст модели не попадают
(ADR-0001 §13). Daemon, работающий от `service:daemon`, использует credentials владельца Run только если
политика `daemon.actAsOwner: true` (по умолчанию — да на локальной машине владельца, нет — в shared runtime,
где это задача backend). Это и есть практическая причина иметь актора уже в v0.1: без него daemon не знает,
чьи токены брать.

### 5. Что не делается сейчас

Нет аутентификации, ролей и прав — local-first, один пользователь. Policy Engine не принимает решений по
актору (кроме `kind = ci` → non-interactive профиль, ADR-0009). Это осознанно: схема готова, логика
появится вместе с backend.

### Как сделано

- Движок исполняет Run внутри контекста «кто действует» (`actingAs`, AsyncLocalStorage): событие без своего
  `actor` — вызов модели, инструмента, эффект, checkpoint — получает актора исполнения и `onBehalfOf`.
  Событие со своим актором (решение человека, записанное во время тика daemon) остаётся его и `onBehalfOf` не
  получает. В таблице `events` — колонка `on_behalf_of` (миграция 6).
- `jarvis daemon` исполняет Run как `service:daemon`, `onBehalfOf` — владелец Run. CI: актор — `ci:…`
  (`JARVIS_ACTOR` при `CI`), `onBehalfOf` — из `JARVIS_ON_BEHALF_OF`, если job его задал.
- `daemon.actAsOwner` (`~/.jarvis/config.yaml`, по умолчанию `true`): при `false` эффект, которому нужны
  credentials владельца (push и PR доставки, ADR-0003 §4), паркует Run в `WAITING_HUMAN` с причиной;
  `jarvis continue` владельца доводит его до конца. Credentials MCP по-прежнему разрешаются keychain'ом машины.
- Лента «Activity» на странице прогона пишет «— daemon от имени <владелец>» там, где действовал не владелец.

## Последствия

- Все durable-записи и экспортируемые traces с первого дня содержат актора; миграции при переходе к shared
  runtime не требуется.
- Комментарии и PR, созданные Jarvis, можно атрибутировать человеку, а не «боту».
- Небольшая стоимость: одно поле в схемах и резолвер при старте CLI.

## Альтернативы

- **Добавить при переходе к shared runtime.** Миграция Run/effects/approvals/traces и потеря атрибуции для
  всего, что было до — ради экономии одного поля сейчас.
- **Актор = agentId.** Смешивает «кто решил» и «что исполняло»; аудит требует обоих.
