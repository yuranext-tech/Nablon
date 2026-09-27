# Nablon R1 — текущая архитектура

> Версия: 27 сентября 2026.
>
> Это текущая консолидированная версия архитектуры R1, собранная из последних решений проекта. Это не дословная копия старого документа Claude.

## 1. Назначение R1

R1 — исполнительный слой Nablon. Он отвечает за корректное выполнение протокола эпизода и сохранение последовательности событий.

R1 не зависит от исследовательских гипотез измерительного слоя и не определяет сам, является ли поведение пользователя доказательством PROCESS_SWITCH.

Основные свойства R1:
- детерминированная state machine;
- immutable canonical events;
- optimistic version locking;
- idempotent command receipts;
- атомарное применение команды;
- защита от конкурентных операций одного эпизода.

## 2. Основные сущности

### Episode

Эпизод — ограниченная во времени единица взаимодействия.

Минимально содержит:
- `episode_id`;
- `user_id`;
- текущую `version`;
- `status`;
- протокольное `state`;
- последовательность/ссылки на canonical events;
- `trace_sequence` — монотонный порядковый номер последней зафиксированной попытки команды в raw trace.

`trace_sequence` не является версией протокольного состояния и не используется для optimistic locking. Он нужен только для восстановления порядка сырых попыток.

Episode хранит только состояние, необходимое для исполнения протокола и восстановления raw trace. Долговременная интерпретация поведения не является его ответственностью.

### Command

Command — намерение изменить состояние Episode.

Контракт:
- `command_id`;
- `episode_id`;
- `expected_version`;
- `type`;
- `payload`.

Каждая команда:
1. проверяется относительно текущего состояния;
2. либо порождает canonical events;
3. либо отклоняется как технически/протокольно недопустимая;
4. получает idempotency receipt, если дошла до исполнения Application.

`command_id` генерируется один раз для пользовательского действия до первой попытки доставки и сохраняется при transport retry. Он не выводится из содержимого команды.

### CanonicalEvent

CanonicalEvent — неизменяемая запись фактически принятого изменения состояния.

Минимально содержит:
- `event_id`;
- `episode_id`;
- `sequence`;
- `command_id`;
- `type`;
- `payload`;
- `occurred_at`.

События образуют последовательность, достаточную для восстановления состояния и последующей реконструкции поведения.

## 3. Raw Episode Event Log

Raw trace состоит из двух связанных типов фактов:
- `CanonicalEvent` — принятые протокольные изменения;
- `Receipt` — зафиксированные попытки команд, включая `REJECTED`.

Raw trace не является evidence.

Ключевой принцип: нельзя сводить журнал сразу к выводу вроде A → B. Нужно сохранять последовательность исходных событий и попыток, чтобы позже можно было:
- переинтерпретировать эпизод;
- обнаружить составной переход;
- применить другой классификатор;
- проверить альтернативную трактовку;
- увидеть последовательности вроде `REJECTED → REJECTED → APPLIED`.

R1 не определяет, какие receipt-записи содержательно значимы. Это задача Measurement Layer.

Технические события вроде `IllegalTransition` не становятся raw behavioral event автоматически. Они относятся к отдельному техническому аудиту/телеметрии. При этом receipt доменно отклонённой пользовательской команды сохраняется как факт попытки, если команда дошла до Application и получила `REJECTED`.

## 4. Candidate

LLM или другой внешний компонент может предложить Candidate, относящийся к конкретному фрагменту raw event sequence.

Candidate — объект R1, а не evidence.

Он должен ссылаться на диапазон событий, например:
- start_event_id;
- end_event_id.

Исходные события при этом остаются неизменяемыми.

### Lifecycle Candidate

В R1 достаточно двух состояний:

- PROPOSED
- REVOKED

R1 не должен иметь состояний CONFIRMED или REJECTED, если они означают исследовательскую квалификацию кандидата.

Причина: подтверждение кандидата как evidence относится к Measurement Layer, а не к исполнению Episode.

Отдельное состояние EXPIRED также не требуется. Операционно просроченные кандидаты могут определяться запросом по времени/очереди обработки. Если кандидат больше не должен обрабатываться, используется REVOKED с причиной.

## 5. Revocation

REVOKED имеет перспективный смысл.

Он:
- запрещает дальнейшую обработку кандидата;
- не удаляет raw events;
- не удаляет сам Candidate;
- не отменяет уже завершённые Measurement Runs;
- не переписывает исторические гипотезы Becoming.

Удаление данных по требованиям приватности — отдельная политика и не является обычным REVOKE.

## 6. Measurement Layer

Measurement Layer отделён от R1.

Он получает Candidate и выполняет одну или несколько независимых процедур измерения.

Для каждого запуска сохраняется immutable MeasurementRun, включающий как минимум:
- candidate_id;
- measurement_run_id;
- версию классификатора/правил;
- идентификатор кодировщика или pipeline;
- результат;
- время запуска.

Один Candidate может иметь несколько Measurement Runs.

Новый классификатор не переписывает старый результат. История измерений сохраняется.

## 7. Evidence

Evidence возникает не в R1, а через Measurement Layer.

Рабочая цепочка:

Raw behavior
→ Action class
→ PROCESS_SWITCH (или другая классификация)
→ REJECT / UNCERTAIN / EVIDENCE
→ накопление
→ pattern hypothesis
→ Becoming

Raw behavior не равно evidence.

Один удачный или неудачный эпизод не должен автоматически превращаться в устойчивое утверждение о пользователе.

## 8. Версионирование интерпретации

Hypothesis в Becoming должна быть привязана к конкретным measurement_run_id и версиям классификатора.

Если новый классификатор расходится со старым:
- старый Measurement Run остаётся;
- старая гипотеза не переписывается задним числом;
- новый запуск может породить новую интерпретацию/гипотезу.

Это сохраняет происхождение каждого вывода и позволяет избежать скрытого retroactive recalculation.

## 9. Idempotency

Повторная доставка одной и той же команды не должна создавать повторное изменение состояния.

R1 использует idempotency receipt.

### Семантика command_id

`command_id`:
- создаётся адаптером один раз на пользовательское действие;
- сохраняется неизменным при transport retry;
- не вычисляется из command contents;
- уникален для конкретной попытки пользовательского действия.

### Приоритет idempotency

Проверка receipt выполняется после захвата lock и **до** проверки `expected_version`.

Если receipt для `command_id` уже существует:
- команда не исполняется повторно;
- текущая версия Episode не проверяется для целей отказа;
- возвращается сохранённый исходный ApplicationResult;
- статус результата: `REPLAYED`.

Таким образом, idempotency побеждает version conflict для уже исполненной команды.

Если receipt отсутствует, применяется обычная проверка `expected_version`. Новый command с устаревшей версией получает `CONFLICT`.

### Receipt

Receipt хранит не только факт исполнения, а сериализованный **полный ApplicationResult** исходной команды, включая:
- status;
- command_id;
- episode_id;
- episode_version;
- canonical_events[].

Дополнительно Receipt является частью raw trace и содержит:
- `trace_sequence` — монотонный порядок попытки внутри Episode;
- `occurred_at` — время фиксации попытки в R1.

`trace_sequence` относится к raw-attempt sequence, а не к `CanonicalEvent.sequence` и не к `Episode.version`.

Поэтому `REPLAYED` может вернуть тот же результат, который получил исходный клиент, а Measurement Layer при необходимости может восстановить порядок `REJECTED → REJECTED → APPLIED`, не заставляя R1 классифицировать эти попытки.

Receipt входит в ту же атомарную границу, что и изменение Episode и canonical events.

## 10. Concurrency

Для операций одного Episode применяется keyed mutex или эквивалентная сериализация по `episode_id`.

Последовательность исполнения команды начинается с захвата соответствующего lock.

Это означает, что конкурентный retry с тем же `command_id`, пришедший до завершения первой команды, ждёт lock; после commit он видит receipt и получает `REPLAYED`.

Дополнительно состояние защищается optimistic version locking.

Цель:
- две конкурентные команды не должны незаметно потерять изменения друг друга;
- повторная команда не должна создавать дубликат;
- частично применённая команда не должна оставлять состояние.

Глобальный mutex для всех эпизодов не требуется и не является контрактным решением.

## 11. Atomic rollback

Применение команды должно быть атомарным.

Если любая часть операции завершается ошибкой, не должно оставаться частично записанного состояния.

Это относится к:
- state transition;
- canonical events;
- idempotency receipt;
- raw trace sequence;
- связанным R1-изменениям.

Концептуальная граница операции:

lock Episode
→ check receipt
→ load Episode
→ check expected_version
→ reducer
→ EventDraft[]
→ materialize CanonicalEvent[]
→ atomically persist Episode + events + receipt
→ return ApplicationResult

Ошибки до commit не должны оставлять частично применённое состояние.

Для будущего Postgres Repository атомарность является отдельным acceptance-критерием: Episode, canonical events, raw trace metadata и receipt должны сохраняться в одной реальной multi-row/multi-table транзакции и завершаться одним `COMMIT`. In-memory rollback не считается доказательством Postgres-атомарности.

## 12. Application layer

Application layer является единой точкой исполнения use case.

### ApplicationResult

ApplicationResult содержит только факты о выполнении:

- `status`;
- `command_id`;
- `episode_id`;
- `episode_version`;
- `canonical_events[]`.

Рекомендуемые статусы:
- `APPLIED`;
- `REPLAYED`;
- `REJECTED`;
- `CONFLICT`.

В ApplicationResult не должно быть:
- `next_action`;
- `prompt`;
- `message`;
- `effect`;
- `suggestion`;
- другого предписания адаптеру о том, что делать дальше.

При `CONFLICT` поле `episode_version` содержит **актуальную текущую версию Episode**, а не `expected_version` из команды. Это позволяет адаптеру при необходимости пересобрать команду без дополнительного чтения Episode.

Application не управляет Telegram/UI/external effects. Адаптер получает ApplicationResult и сам, как отдельная функция от результата, решает, какое внешнее действие выполнить.

### Repository contract

Концептуальный Repository/Application boundary:

`getEpisode(episodeId)`
`getReceipt(commandId)`
`saveEpisodeAtomically(episode, canonicalEvents, receipt)`
`withEpisodeLock(episodeId, operation)`

Транзакционные детали не должны протекать в Application через явные `begin/commit/rollback`; Repository должен скрывать механизм и гарантировать контракт атомарности.

Нельзя сохранять две расходящиеся схемы создания Episode, например:
- один путь через R1Protocol.openEpisode(), который создаёт EPISODE_OPENED / PROBE_PRESENTED;
- другой путь через Application.createInitialEpisode(), который обходит canonical event flow.

Создание Episode должно иметь один канонический путь.

## 13. EventDraft и composite transitions

Reducer не должен агрегировать несколько поведенчески значимых промежуточных шагов в один семантически богатый итоговый event.

`EventDraft` представляет один наблюдаемый/протокольно значимый шаг изменения состояния.

Если потеря промежуточного шага может изменить последующую интерпретацию поведения, он должен быть отдельным EventDraft и после materialization — отдельным CanonicalEvent.

Например:

STOP
→ RECONSIDER
→ CHANGE_APPROACH

должно сохраняться как три последовательных события, а не как единый `PROCESS_SWITCHED`.

При этом не каждая внутренняя переменная reducer обязана становиться событием. Критерий — поведенческая/протокольная значимость и возможность последующей реконструкции.

**Текущий статус composite-emission:** reducer технически способен вернуть `EventDraft[]` длиной больше 1, а Application корректно materialize-ит такой массив в последовательные `CanonicalEvent`. Это проверено синтетическим тестом `T05` на одной команде `RECONSIDER_AND_CHANGE_APPROACH`. Это не означает, что вся реальная семантика составных переходов R1 уже исчерпывающе валидирована.

## 14. Telemetry

Операционная телеметрия должна быть отделена от raw behavioral log.

Примеры технических/операционных событий:
- support requested;
- candidate rejected at protocol boundary;
- illegal transition;
- processing failure.

Они полезны для эксплуатации и диагностики, но не должны автоматически становиться материалом для Measurement Layer.

Receipt `REJECTED` не является операционной telemetry: это факт command attempt, доступный raw trace. R1 при этом не определяет, является ли эта попытка содержательно значимой.

## 15. Граница R1 и исследований

R1 отвечает на вопрос:

Что произошло в протоколе и как корректно сохранить это состояние?

Measurement Layer отвечает на другой вопрос:

Что можно обоснованно классифицировать или измерить по сохранённому поведению?

Becoming отвечает ещё на следующий вопрос:

Какие устойчивые паттерны можно формулировать на основании накопленного и версионированного evidence?

Смешивать эти три уровня нельзя.

## 16. Текущие открытые задачи R1

1. Реализовать/проверить единый canonical Episode creation path.
2. Зафиксировать полный Application/Repository telemetry contract.
3. Проверить CandidateProposer → Candidate flow без протекания measurement semantics в R1.
4. Убедиться, что raw event sequence сохраняется достаточно подробно для composite transitions и будущей переклассификации.
5. Проверить idempotency, rollback и per-episode concurrency на всех новых командах.
6. Реализовать Postgres Repository с настоящей multi-row/multi-table atomic transaction и отдельными acceptance-тестами.
7. Спроектировать episode-scoped cutover и физически изолированный shadow namespace до начала production shadow/cutover.
8. Не добавлять в R1 lifecycle-состояния, которые принадлежат Measurement Layer.

## 17. Что сознательно не входит в R1

- оценка интеллекта, рациональности или когнитивной мощности пользователя;
- итоговые пользовательские scores/rankings;
- доказательство PROCESS_SWITCH;
- подтверждение evidence;
- долговременные гипотезы о пользователе;
- retroactive переписывание исторических измерений;
- автоматическая диагностика способности по одному эпизоду.

## 18. Extraction boundary: what "minimal R1" means

The first extraction step is deliberately narrow.

### Included

The R1 core may contain only:
- Episode domain state and reducer;
- Command validation/execution;
- immutable CanonicalEvent production;
- idempotency receipt handling;
- optimistic version check;
- in-memory Repository;
- Application use-case boundary;
- deterministic tests for the above.

### Explicitly excluded from this step

The following must not be pulled into the core merely because they are convenient during extraction:
- PostgreSQL persistence;
- Telegram/Telegraf integration;
- current `users`, `probes`, `observations` tables as domain storage;
- Measurement Layer;
- PROCESS_SWITCH classification;
- Evidence Gate;
- Becoming/hypothesis generation;
- Candidate measurement qualification;
- long-term user interpretation;
- product engagement/push scheduling.

The previously deferred R1 questions are not reopened by extraction:
- pendingCandidate lifecycle remains R1-only and must not acquire measurement semantics;
- telemetry contract remains a separate architectural task;
- `CONFIRM_CANDIDATE` does not become an evidence-confirmation command inside R1.

The purpose of the extraction is to establish a clean executable core, not to complete every surrounding contract.

## 19. Adapter boundary

The legacy bot is an adapter around R1, not a second implementation of R1.

There must be one narrow application-facing entry point for protocol execution:

Legacy/Telegram layer
→ Application command
→ R1 domain execution
→ canonical result/events
→ adapter performs external side effects.

The legacy layer must not:
- mutate Episode state directly;
- write R1 events directly;
- read internal reducer state to make protocol decisions;
- introduce ad-hoc alternate Episode creation paths.

A temporary compatibility mapping from legacy observations to R1 commands/events is allowed at the adapter boundary. It must remain explicit and removable.

"One point of entry" refers to protocol execution, not to every infrastructure operation in the whole application.

## 20. Existing observations: archive first, migration later

Historical `users/probes/observations` data is not automatically converted into the new Raw Episode Event Log.

Initial R1 integration starts with a clean R1 event history for new episodes.

Existing observations remain legacy/archive data unless and until a separately specified migration proves that their original event sequence can be reconstructed without inventing missing events.

This means:
- old observations may be retained for product continuity and historical analysis;
- they are not silently declared R1 events;
- they are not automatically treated as new evidence;
- any future backfill must be a separate, versioned migration with explicit provenance and uncertainty.

No production integration step may depend on a retroactive backfill being completed first.

## 21. Extraction invariant: one authority per episode

During the strangler extraction, both systems may temporarily coexist, but only one system may be authoritative for a given concern **and episode**.

For protocol execution, the cutover boundary is **episode-scoped, not time-scoped**:

- an Episode that was already opened in legacy before cutover remains owned by legacy and is completed there;
- R1 does not take over an already-open legacy Episode merely because the wall-clock time passed the cutover;
- only Episodes opened after the cutover are handed to R1 as authoritative;
- once an Episode is handed to R1, legacy must not continue executing that Episode's protocol.

Therefore there is never a production protocol Episode for which legacy and R1 are co-equal mutable authorities.

Legacy historical data remains authoritative for its own historical record until a separately specified migration replaces or supplements it.

## 22. Shadow execution isolation

Phase A shadow execution is non-authoritative and must be physically isolated from production R1 state.

A shadow run may use copies of real commands and real `command_id`/`episode_id` values for meaningful comparison, but its:
- Episode records;
- CanonicalEvents;
- receipts;
- and other mutable R1 state

must be stored in a separate non-authoritative namespace/storage that production execution never reads.

The production path for:
- `getEpisode`;
- `getReceipt`;
- idempotency checks;
- authoritative writes

must never consult shadow state.

This prevents a shadow receipt from causing a future production command with the same `command_id` to be incorrectly returned as `REPLAYED`, and prevents shadow Episodes/events from colliding with authoritative history.

"Discarded" in Phase A therefore means not merely "ignored by the UI", but "outside every production read/write path".

## 23. Cutover phases

### Phase A — Shadow

- Legacy remains authoritative.
- R1 may execute a shadow copy of the same use case.
- Shadow state is physically isolated and non-authoritative.
- Shadow results are observed/compared but cannot affect production state, receipts, or adapter behavior.

### Phase B — Episode-scoped cutover

- New Episodes for the selected use case are opened through R1.
- Already-open legacy Episodes remain in legacy until completion.
- Legacy execution for an R1-owned Episode is disabled.
- R1 becomes the sole authoritative protocol executor for those Episodes.

### Phase C — Removal

- After the cutover boundary is stable, the legacy execution path for the selected use case is removed.
- Legacy historical records remain available as archive unless separately migrated.

The transition must not be implemented as two co-equal production writers.

## 24. Contract execution sequence

For a new command:

lock Episode
→ check receipt
→ load Episode
→ check expected_version
→ reducer
→ EventDraft[]
→ materialize CanonicalEvent[]
→ atomically persist Episode + events + full ApplicationResult receipt
→ return ApplicationResult(APPLIED)

For an existing receipt:

lock Episode
→ check receipt
→ return stored ApplicationResult(REPLAYED)

For a new command with stale version:

lock Episode
→ check receipt (absent)
→ load Episode
→ detect version conflict
→ return ApplicationResult(CONFLICT, episode_version=current_version)

For a domain-invalid command:

lock Episode
→ check receipt (absent)
→ load Episode
→ version check
→ domain validation/reducer rejection
→ persist raw trace sequence + receipt
→ return ApplicationResult(REJECTED).

`REJECTED` is an окончательный результат конкретного command attempt. Если команда дошла до Application и получила `REJECTED`, receipt сохраняется с полным `ApplicationResult`, `trace_sequence` и `occurred_at`. Повтор той же команды по тому же `command_id` возвращает `REPLAYED` с тем же сохранённым результатом; команда не исполняется повторно. При этом rejected command не должна создавать domain state change или canonical events, если конкретный command contract явно не определяет иное.

## 25. Extraction acceptance invariants

Before handing extraction to implementation, the following must be testable:

1. **Idempotent replay:** same `command_id` returns the stored full ApplicationResult and does not mutate Episode again.
2. **Replay wins over version conflict:** an already-receipted command returns `REPLAYED` even if its original `expected_version` is now stale.
3. **Fresh stale command conflicts:** a new `command_id` with stale `expected_version` returns `CONFLICT` and the current `episode_version`.
4. **Concurrent retry serialization:** concurrent same-`command_id` calls serialize on the Episode lock; only one applies, the others replay.
5. **Composite event preservation:** behaviorally meaningful intermediate steps are separate EventDrafts/CanonicalEvents.
6. **Atomicity:** failed persistence leaves Episode, events, raw trace sequence, and receipt unchanged.
7. **Postgres atomicity:** when Postgres Repository is implemented, Episode + events + raw trace sequence + receipt commit in one real database transaction.
8. **Episode-scoped cutover:** an open legacy Episode never silently changes authority at a wall-clock cutover boundary.
9. **Shadow isolation:** shadow Episodes/events/receipts are unreachable from production idempotency and Episode reads/writes.
10. **Single authority:** an Episode is executed by exactly one authoritative protocol path.
11. **Ordered rejected attempts:** `REJECTED` receipts carry `trace_sequence` and `occurred_at`, allowing Measurement Layer to reconstruct their position relative to later accepted events without R1 classifying them.

## 26. Current implementation status — 27 September 2026

- Composite emission is implemented and tested by `T05`: one command produces two canonical events from one reducer decision.
- Ordered raw receipt trace is implemented: `Episode.trace_sequence` advances for every executed command attempt that receives `APPLIED` or `REJECTED`.
- `Receipt.trace_sequence` and `Receipt.occurred_at` are persisted atomically with Episode/events/receipt.
- `REJECTED` does not create canonical events and does not increment `Episode.version`; it does advance the raw trace sequence.
- R1 itself does not decide whether a rejected attempt is behaviorally meaningful.
- The acceptance branch `r1-restore-acceptance` restores T07–T11 as executable tests: concurrency + ordering, atomic rollback, external/internal dependency boundaries, canonical Episode creation, and rejected-receipt replay. Their execution still requires a real `npm run r1:test` run; adding the tests is not itself evidence that they pass.
