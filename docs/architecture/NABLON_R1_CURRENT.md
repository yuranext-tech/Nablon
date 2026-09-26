# Nablon R1 — текущая архитектура

> Версия: 26 сентября 2026.
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
- защита от конкурентных операций одного пользователя.

## 2. Основные сущности

### Episode

Эпизод — ограниченная во времени единица взаимодействия.

Он содержит:
- идентификатор эпизода;
- идентификатор пользователя;
- текущую версию;
- состояние эпизода;
- последовательность/ссылки на canonical events;
- при необходимости pendingCandidate.

Episode хранит только состояние, необходимое для исполнения протокола. Долговременная интерпретация поведения не является его ответственностью.

### Command

Command — намерение изменить состояние Episode.

Каждая команда:
1. проверяется относительно текущего состояния;
2. либо порождает canonical events;
3. либо отклоняется как технически недопустимая;
4. получает idempotency receipt.

### CanonicalEvent

CanonicalEvent — неизменяемая запись фактически принятого изменения состояния.

События образуют последовательность, достаточную для восстановления состояния и последующей реконструкции поведения.

## 3. Raw Episode Event Log

Отдельно от canonical state R1 должен сохранять сырой журнал наблюдаемых пользовательских действий и попыток, когда они являются содержательно значимым поведением.

Ключевой принцип: нельзя сводить журнал сразу к выводу вроде A → B.

Нужно сохранять последовательность исходных событий, чтобы позже можно было:
- переинтерпретировать эпизод;
- обнаружить составной переход;
- применить другой классификатор;
- проверить альтернативную трактовку.

Raw log не является доказательством сам по себе.

Технические события вроде IllegalTransition не должны автоматически попадать в Raw Episode Log. Они относятся к отдельному техническому аудиту/телеметрии.

При этом содержательная пользовательская попытка может быть записана даже если соответствующая команда впоследствии не прошла доменную валидацию. Граница проходит между техническим отказом и наблюдаемым поведением пользователя, а не просто между accepted/rejected.

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

Повтор команды с тем же идентификатором должен возвращать ранее зафиксированный результат, а не повторно исполнять команду.

Idempotency должна быть частью атомарной границы изменения состояния.

## 10. Concurrency

Для операций одного пользователя применяется keyed mutex или эквивалентная сериализация.

Дополнительно состояние защищается optimistic version locking.

Цель:
- две конкурентные команды не должны незаметно потерять изменения друг друга;
- повторная команда не должна создавать дубликат;
- частично применённая команда не должна оставлять состояние.

## 11. Atomic rollback

Применение команды должно быть атомарным.

Если любая часть операции завершается ошибкой, не должно оставаться частично записанного состояния.

Это относится к:
- state transition;
- canonical events;
- idempotency receipt;
- связанным R1-изменениям.

## 12. Application layer

Application layer является единой точкой исполнения use case.

Нельзя сохранять две расходящиеся схемы создания Episode, например:
- один путь через R1Protocol.openEpisode(), который создаёт EPISODE_OPENED / PROBE_PRESENTED;
- другой путь через Application.createInitialEpisode(), который обходит canonical event flow.

Следующий архитектурный приоритет: унифицировать создание Episode через один канонический путь.

## 13. Telemetry

Операционная телеметрия должна быть отделена от raw behavioral log.

Примеры технических/операционных событий:
- support requested;
- candidate rejected at protocol boundary;
- illegal transition;
- processing failure.

Они полезны для эксплуатации и диагностики, но не должны автоматически становиться материалом для Measurement Layer.

## 14. Граница R1 и исследований

R1 отвечает на вопрос:

Что произошло в протоколе и как корректно сохранить это состояние?

Measurement Layer отвечает на другой вопрос:

Что можно обоснованно классифицировать или измерить по сохранённому поведению?

Becoming отвечает ещё на следующий вопрос:

Какие устойчивые паттерны можно формулировать на основании накопленного и версионированного evidence?

Смешивать эти три уровня нельзя.

## 15. Текущие открытые задачи R1

1. Унифицировать единственный canonical Episode creation path.
2. Зафиксировать полный Application/Repository telemetry contract.
3. Проверить CandidateProposer → Candidate flow без протекания measurement semantics в R1.
4. Убедиться, что raw event sequence сохраняется достаточно подробно для composite transitions и будущей переклассификации.
5. Проверить idempotency, rollback и per-user concurrency на всех новых командах.
6. Не добавлять в R1 lifecycle-состояния, которые принадлежат Measurement Layer.

## 16. Что сознательно не входит в R1

- оценка интеллекта, рациональности или когнитивной мощности пользователя;
- итоговые пользовательские scores/rankings;
- доказательство PROCESS_SWITCH;
- подтверждение evidence;
- долговременные гипотезы о пользователе;
- retroactive переписывание исторических измерений;
- автоматическая диагностика способности по одному эпизоду.


## 17. Extraction boundary: what "minimal R1" means

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

## 18. Adapter boundary

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

## 19. Existing observations: archive first, migration later

Historical `users/probes/observations` data is not automatically converted into the new Raw Episode Event Log.

Initial R1 integration starts with a clean R1 event history for new episodes.

Existing observations remain legacy/archive data unless and until a separately specified migration proves that their original event sequence can be reconstructed without inventing missing events.

This means:
- old observations may be retained for product continuity and historical analysis;
- they are not silently declared R1 events;
- they are not automatically treated as new evidence;
- any future backfill must be a separate, versioned migration with explicit provenance and uncertainty.

No production integration step may depend on a retroactive backfill being completed first.

## 20. Extraction invariant

During the strangler extraction, both systems may temporarily coexist, but only one system may be authoritative for a given concern.

For protocol execution:
**R1 is authoritative once an Episode is handed to the R1 path.**

For legacy historical data:
**legacy observations remain authoritative for their own historical record until a separately specified migration replaces or supplements them.**

The adapter may translate between the two representations, but the two representations must not become co-equal mutable sources of truth.
