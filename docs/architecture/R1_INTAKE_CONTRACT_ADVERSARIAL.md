# R1 Intake Contract — adversarial review

## Purpose

This document defines the attack surface around the adapter-owned intake boundary before an Intake Contract implementation is designed.

The contract is intentionally separated from R1 domain semantics. R1 owns protocol execution, persistence, receipts and canonical events. The adapter owns transport identity, intake, routing context, outbox state and external effects.

Conceptually:

`external delivery -> delivery_id -> command_id -> durable intake -> Application.execute() -> R1 result -> outbox claim -> external effect`

The purpose of intake is recovery across failures before and around the R1 call. It is not a second protocol journal and must not become one.

## Boundaries

### Adapter owns

- transport-specific delivery identity and deduplication;
- mapping/reuse from `delivery_id` to stable `command_id`;
- durable intake records;
- minimal normalized command/input context needed for recovery;
- transport/routing context needed to reconstruct an external effect;
- outbox lifecycle and delivery state;
- reconciliation cursors and worker ownership.

### R1 owns

- protocol validity;
- `expected_version` checks;
- Episode mutation;
- receipts;
- `trace_sequence`;
- canonical events;
- command idempotency.

R1 does not know Telegram, chat IDs, locale, UI concepts, or external effect types.

### Current topology assumption

The statement that `Application.execute()` does not need an `AMBIGUOUS` intake state is a consequence of the current topology: the adapter calls R1 in-process, synchronously, with an atomic R1 transaction. If R1 ever becomes a separate service across a network boundary, `intake -> R1` acquires the same class of uncertainty that currently exists only at `outbox -> transport`. At that point this contract must be reviewed again; the current in-process property must not be treated as a permanent architectural law.

## Core invariants

1. **Durable intake precedes R1 execution.** A worker must not call `Application.execute()` until the intake record needed for recovery is durably committed.
2. **Same external delivery means same command identity.** For a repeated delivery of the same external event, the adapter must reuse the same `command_id`. The exact mapping from `delivery_id` is transport-owned.
3. **Same command_id is safe to retry.** R1 command idempotency protects repeated execution of the same command.
4. **The original `expected_version` is part of intake.** Reconciliation must retry with the version captured for the original command, never with a freshly read current version.
5. **No-result intake reconciliation gets one semantic retry.** If intake exists but no R1 result is observed, the adapter may retry the same `command_id` once. If that retry returns `REPLAYED`, the adapter must inspect the effective result represented by `canonical_events`.
6. **`REPLAYED` is transparent for effect routing.** `canonical_events.length > 0` means the original command produced an applied domain transition and therefore requires the R1→outbox path. An empty canonical-event list means no such effect intent exists.
7. **`CONFLICT` is terminal for that command during reconciliation.** A reconciliation retry that discovers `CONFLICT` confirms that this command did not apply under its original `expected_version`. Automatic recovery must not refresh the version and silently create a new command.
8. **`AMBIGUOUS` belongs to external delivery only under the current in-process topology.** It describes uncertainty after an external send/acknowledgement boundary. The current in-process R1 call is atomic and therefore does not require an ambiguous intake state. If R1 becomes a network service, this assumption expires and the intake contract must be reconsidered.
9. **Intake→R1 concurrency needs no separate claim.** Concurrent retries of the same `command_id` are protected by R1 idempotency; T07 already demonstrates this class of race.
10. **R1→outbox concurrency does require a claim.** Only the worker that atomically creates/claims the missing outbox intent may call the external transport.
11. **Recovery cursor follows the full trace.** A recovery stream may filter to `APPLIED` decisions, but its resumable cursor is positioned in the full monotonic `trace_sequence`, including rejected positions.
12. **Pre-intake crash is safe.** If durable intake was never committed, neither R1 nor the external effect was legitimately reached through that intake. A later repeated external delivery may start from scratch without creating a duplicate effect through this incomplete intake.
13. **Intake is adapter operational state, not behavioral history.** It may be retained only for the recovery window and archived/deleted after terminal handling plus a safety margin.
14. **Intake is minimal and normalized.** It stores enough adapter-owned context to reconstruct/retry the command and effect, but does not turn raw transport payloads into a second durable event log.

## Attack 1 — duplicate external delivery before command_id creation

Attack:
- deliver the same external event twice;
- make the deliveries concurrent;
- verify that both deliveries resolve to the same `command_id`.

Failure mode:
- each transport delivery creates a fresh command ID;
- both reach R1 as distinct commands;
- R1 idempotency cannot detect the duplicate because it only knows `command_id`.

Required property:

`delivery_id -> deterministic/reused command_id`

The mapping is generic. Telegram-specific delivery semantics must remain inside the adapter.

## Attack 2 — crash during initial durable intake write

Attack:
- receive an external delivery;
- begin writing intake;
- terminate the worker before intake is durably committed;
- later receive/recover the same external delivery.

Required conclusion:

If intake was not durably committed, the system has no durable adapter obligation from that incomplete attempt. R1 has not been legitimately entered through the missing intake record, and no external effect has been created through it. A repeated delivery may create the intake record anew and proceed normally.

This closes the window explicitly rather than treating a partially written intake as an ambiguous command.

## Attack 3 — durable intake exists, but R1 was never called

Attack:
- durably commit intake;
- crash before `Application.execute()`;
- restart reconciliation;
- observe that intake has no R1 result.

The adapter may retry using the exact `command_id` and original `expected_version` stored in intake.

This is the simple case of the no-result recovery rule: the retry is the first actual R1 execution.

## Attack 4 — R1 was called, but its result was not observed

Attack:
- durably commit intake;
- call `Application.execute()`;
- allow R1 to commit;
- crash before the adapter observes/persists the returned result;
- restart reconciliation.

Two cases are intentionally indistinguishable from the adapter's local observation:

1. the call never happened;
2. the call happened and completed, but its result was lost to the adapter.

The same retry resolves both cases because the retry uses the same `command_id` and original `expected_version`.

- Case 1 → real execution.
- Case 2 → `REPLAYED` with the stored result.

There is no need for an `AMBIGUOUS` intake state because `Application.execute()` is synchronous in-process and its R1 transaction is atomic **under the current topology assumption**. If that boundary becomes remote, this conclusion no longer holds.

## Attack 5 — exactly-one retry semantics

Attack:
- create an intake with no observed R1 result;
- allow multiple reconciliation cycles/workers to encounter it.

The contract must distinguish the semantic retry from arbitrary repeated business attempts.

Concurrent workers may both call R1 with the same `command_id`; R1 idempotency makes this safe. A separate adapter claim mechanism is not required on Intake→R1.

After a definitive result has been recovered, the intake must not be converted into a fresh command with a new `command_id`.

## Attack 6 — reconciliation returns APPLIED

Attack:
- intake has no observed result;
- reconciliation executes/retries;
- R1 returns `APPLIED`.

Required routing:

`APPLIED -> create/claim outbox intent -> external delivery`

The adapter must not execute the command again merely because outbox creation or delivery later fails. R1's accepted transition is already authoritative.

## Attack 7 — reconciliation returns REJECTED

Attack:
- intake has no observed result;
- reconciliation executes/retries;
- R1 returns `REJECTED`.

Required routing:
- no external effect intent is created merely because the command was received;
- the result may be rendered/reported by the adapter according to transport needs;
- the command is not automatically retried as a new protocol decision.

A rejected attempt remains a recorded R1 fact but does not create a canonical domain transition.

## Attack 8 — reconciliation returns CONFLICT

Attack:
- intake contains `expected_version = V`;
- current R1 episode version has advanced;
- reconciliation retries using the original `V`;
- R1 returns `CONFLICT`.

This is a terminal outcome for that `command_id` in reconciliation.

The adapter must not:
- fetch the current Episode version as a substitute for the original expected version;
- silently update intake to the new version;
- execute a new command under the same semantic attempt.

If the product wants to offer a new action based on the new state, that is a separate command with a new `command_id`, outside this recovery contract.

A suitable adapter terminal marker may be `CONFLICT_CONFIRMED` or equivalent. The exact name is implementation detail; it must not imply that a new domain decision was applied.

## Attack 9 — REPLAYED after hidden APPLIED must not lose the effect

Attack:
- original R1 execution actually returned `APPLIED`;
- adapter crashed before observing that result;
- reconciliation retries the same `command_id`;
- R1 returns `REPLAYED`.

The adapter must not branch on `status === REPLAYED` and discard the result.

The authoritative routing test is:

`canonical_events.length > 0 -> treat as effective APPLIED -> outbox path`

`canonical_events.length === 0 -> no canonical transition -> no outbox intent`

This is necessary because `REPLAYED` by itself does not encode whether the original result was `APPLIED` or `REJECTED`.

## Attack 10 — incomplete or corrupted intake

Attack:
- intake exists but lacks required command data, original `expected_version`, stable identity, or the minimal context needed to reconstruct an effect;
- reconciliation attempts recovery.

Required behavior:
- do not guess missing protocol data;
- do not fetch current Episode state to fill the missing expected version;
- do not manufacture a new command ID to bypass the damaged record;
- place the intake into an explicit operational error/quarantine state requiring repair or deliberate handling.

The contract should define required fields as an atomic durability boundary: an intake record is either complete enough for recovery or it does not count as a valid intake.

## Attack 11 — effect reconstruction after R1 recovery

Attack:
- R1 has an `APPLIED` decision;
- adapter outbox record is missing;
- reconciliation discovers the decision;
- verify that the adapter can reconstruct the external effect without asking R1 to understand transport details.

The missing data must come from adapter-owned intake/context plus the R1 result/canonical events that are already exposed by the recovery interface.

Do not expand `Receipt` with `chat_id`, locale, Telegram message identifiers, or other transport routing fields merely to make reconciliation convenient. That would violate the R1/Adapter boundary.

## Attack 12 — retention and late reconciliation

Intake is operational recovery state, not permanent behavioral history.

The adapter may archive/delete intake after:
- the R1 outcome is terminal for that command;
- the required external effect has reached a terminal adapter state;
- a safety window covering the maximum expected reconciliation delay has elapsed.

The exact retention period is an adapter operational parameter. It must be long enough that a delayed recovery worker cannot encounter a missing intake while an unresolved outbox/effect still depends on its routing context.

R1 receipts and trace history remain the durable source of accepted protocol history.

## Attack 13 — concurrent R1→Outbox reconciliation

Attack:
- two workers read the same `APPLIED` decision with no outbox entry;
- both attempt to create the external effect intent;
- both must not call `transport.send()`.

Required mechanism:
- atomic insert-if-absent / unique ownership on the outbox intent;
- only the worker whose claim/insert succeeds may send;
- the losing worker exits or observes the already-owned outbox state.

This claim is deliberately not mirrored on Intake→R1. R1 command idempotency already protects that direction.

The claim only protects the race before sending. It does not resolve ambiguous transport acknowledgement after sending.

## Attack 14 — recovery stream cursor semantics

The adapter recovery stream may expose only decisions relevant to effect recovery, such as `APPLIED` results. Its cursor must nevertheless advance in the coordinate system of the full monotonic `trace_sequence`.

Example:

`trace_sequence: 10 REJECTED, 11 APPLIED, 12 REJECTED, 13 APPLIED`

A consumer starting after 10 and receiving only APPLIED records must receive 11 and 13, but its cursor must represent progress through the underlying trace, not become `APPLIED #2`.

Otherwise the adapter cannot distinguish:
- which part of the authoritative trace has already been examined;
- whether a rejected position was skipped intentionally;
- whether a later APPLIED decision is before or after the recovery boundary.

The exact `listReceiptsSince()` / `listAppliedSince()` API is intentionally left for the next design step.

## Attack 15 — claim without an outcome

Attack:
- a reconciliation worker atomically claims an outbox intent;
- the worker dies before recording any outcome such as `DELIVERED`, `RETRYABLE` or `AMBIGUOUS`;
- the claim remains present and blocks every later worker indefinitely.

Required mechanism:
- the claim must carry durable ownership metadata such as `worker_id` and `claimed_at`;
- a lease/expiry defines how long an uncompleted claim remains owned;
- after the lease expires, another reconciliation worker may atomically reclaim the intent;
- a fresh claim must not be confused with `AMBIGUOUS`: `AMBIGUOUS` means a transport attempt occurred but its delivery result is unknown, while an expired claim may mean the transport attempt never began.

The lease protects against a dead claimant, not against uncertain transport acknowledgement. Those remain separate recovery problems.

## Recovery flows

### Intake → R1

`external delivery`

↓

`delivery_id dedup`

↓

`stable command_id`

↓

`durable intake`

↓

`Application.execute()`

↓

`APPLIED | REJECTED | CONFLICT | REPLAYED`

For `REPLAYED`, route by the effective result represented by `canonical_events`, not by the `REPLAYED` label itself.

### R1 → Outbox

`APPLIED / effective APPLIED`

↓

`recovery stream`

↓

`atomic outbox claim`

↓

`transport.send()`

↓

`DELIVERED | RETRYABLE | AMBIGUOUS`

Only this second direction needs the explicit adapter-owned claim.

## Open contract questions

1. What exact transport-independent representation defines `delivery_id`?
2. Where is the durable `delivery_id -> command_id` mapping stored?
3. Which normalized command fields are mandatory in intake?
4. Which adapter-owned routing fields are required to reconstruct each effect?
5. What exact terminal state represents a confirmed reconciliation `CONFLICT`?
6. What is the maximum reconciliation interval that determines intake retention?
7. What unique key/constraint provides the outbox claim?
8. What exact effect identity is used if one R1 decision can eventually produce multiple external effects?
9. What transport acknowledgement semantics distinguish `DELIVERED`, `RETRYABLE` and `AMBIGUOUS`?
10. What narrow R1 recovery stream is needed to expose already accepted `APPLIED` decisions while keeping protocol authority inside R1?
11. What lease duration and reclaim semantics apply to an outbox claim that has no recorded outcome?

## Non-goals

This document does not implement:
- R1 domain changes;
- `Receipt` expansion with transport-specific data;
- Telegram-specific delivery mapping;
- the intake persistence implementation;
- the outbox implementation;
- the recovery stream API;
- shadow/cutover infrastructure;
- external transport integration.

The next step is to design the narrow R1 recovery stream semantics and only then determine the minimum persistence interfaces required by the adapter.
