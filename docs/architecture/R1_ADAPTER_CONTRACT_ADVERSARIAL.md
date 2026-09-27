# R1 Adapter Contract — adversarial review

## Purpose

This document is a pre-contract attack surface. It is intentionally written before fixing an Adapter Contract implementation.

The current R1 branch exposes `Application.openEpisode()` and `Application.execute()` and returns `ApplicationResult`. There is no Adapter implementation in R1 yet. Therefore the items below are constraints to attack before the adapter contract is frozen, not claims about an existing adapter.

## Candidate boundary

The adapter owns transport and external effects. R1 owns protocol execution and persistence.

Conceptually:

`external input -> adapter -> Command -> Application -> ApplicationResult -> adapter -> external effect`

The adapter must not become a second application layer.

## Attack 1 — duplicate command_id

**Invariant:** one user action gets one stable `command_id`; transport retry reuses it.

Attack:
- deliver the same user action twice concurrently;
- vary transport metadata between deliveries;
- ensure the adapter does not mint a second `command_id` for the retry.

Expected R1 behavior after both deliveries: one applied result and one replay, with one persisted receipt.

A contract that lets the adapter generate a fresh ID per transport delivery is invalid for this protocol.

## Attack 2 — REJECTED treated as an external action

**Invariant:** `REJECTED` is a recorded R1 result, not an instruction to perform an external effect.

Attack:
- produce a rejected command;
- inspect the adapter decision boundary;
- verify that no Telegram/UI/external side effect is implied by the result itself.

The adapter may render or report the result, but R1 must not prescribe the external action.

## Attack 3 — REPLAYED interpreted as new state

**Invariant:** `REPLAYED` means the adapter is receiving the result of an already executed command, not a new protocol transition.

Attack:
- execute a command;
- deliver the same command again;
- verify that the adapter does not emit a second domain action or treat the replay as a new state transition.

The persisted receipt remains the source of the replayed ApplicationResult.

**Outbox routing invariant:** `REPLAYED` is transparent to the decision of whether an external effect intent exists. The adapter must not branch on `status === REPLAYED` as if it were a separate effect outcome. It must inspect the effective result represented by the replay: `canonical_events.length > 0` means the original command was `APPLIED` and an outbox intent is required; `canonical_events.length === 0` means the original command produced no canonical event and no outbox intent is required. `REPLAYED` alone does not preserve whether the original result was `APPLIED` or `REJECTED`.

## Attack 4 — adapter reads or mutates Episode

**Invariant:** the adapter must not read Episode state directly to decide protocol semantics or mutate Episode outside Application. A narrow read-only catch-up stream of already accepted R1 decisions is a separate recovery interface and does not grant protocol authority.

Attack:
- give the adapter access to Repository/Episode;
- attempt to implement version checks, state transitions, or idempotency there.

Any contract requiring such access creates a second protocol executor and defeats the R1 boundary.

The adapter may use data returned in ApplicationResult, including the current `episode_version` on `CONFLICT`, without independently reading Episode.

## Attack 5 — transport semantics leak into R1

**Invariant:** R1 commands contain protocol data, not Telegram/UI concepts.

Attack:
- introduce Telegram message IDs, chat IDs, callback payloads, UI labels, prompts, or transport-specific effect types into `Command`, `ApplicationResult`, `Episode`, or domain events;
- verify that the R1 boundary rejects this dependency rather than normalizing it into the domain.

Transport identity belongs to the adapter. `command_id` is the R1 idempotency identity and must remain stable across transport retries.

## Attack 6 — CONFLICT and REPLAYED collapse

**Invariant:** these statuses have different causes and must remain distinguishable.

`CONFLICT` means a new command reached R1 with an obsolete `expected_version` and has no receipt.

`REPLAYED` means the command already has a receipt and therefore is not executed again.

Attack:
- send a stale new command;
- resend an already applied command after the Episode has advanced;
- verify that the first returns `CONFLICT` while the second returns the stored result as `REPLAYED`.

The adapter must not map both to a generic retry/error path that loses this distinction.

## Attack 7A — side effect before R1 confirmation

**Invariant:** an external side effect must never occur before R1 has accepted the command and `Application.execute()` has resolved with `APPLIED`.

Attack:
- make the adapter perform an external effect before `Application.execute()` resolves;
- force R1 to return `CONFLICT`, `REJECTED`, or throw;
- verify that the contract provides no path in which the premature effect is treated as part of successful R1 execution.

This is not a trade-off or an implementation preference. R1 has no way to roll back an external effect after a rejected/conflicting/failed command. Therefore the ordering invariant is strict: **no external effect before `APPLIED`**.

R1 does not provide distributed transaction semantics with Telegram/UI/external systems. This attack is specifically about preventing the adapter from inverting that order.

## Attack 7B — external effect succeeds or becomes uncertain after R1 commit

**Invariant:** once R1 has returned `APPLIED`, R1 state and receipt remain authoritative even if the subsequent external effect fails or its outcome becomes unknown.

Attack:
- execute a command and obtain `APPLIED` from R1;
- make the adapter fail before the external effect is attempted, or after the effect is attempted but before delivery confirmation is recorded;
- restart the adapter;
- verify that recovery does not call `Application.execute()` as a substitute for recovering the external effect;
- verify that recovery cannot silently lose the effect or create an uncontrolled duplicate.

This is a different failure class from 7A. The R1 transaction has already succeeded. Re-running the command is not the repair mechanism: `REPLAYED` protects the domain transition, but it does not prove whether the external message/effect was delivered.

**Expected contract direction:** the adapter owns a narrow durable outbox/state record independent of the R1 Repository, keyed to the stable `command_id` (or an explicitly derived effect identity). At minimum it must distinguish an effect that is pending from one whose delivery has been confirmed. Recovery retries delivery from the persisted `ApplicationResult`/effect payload rather than executing the domain command again. The adapter marks the effect delivered only after the external transport confirms delivery according to the transport's own acknowledgement semantics.

The exact delivery semantics still need to be specified per transport. In particular, if the transport itself can return an ambiguous outcome (effect may have been accepted but acknowledgement was lost), the adapter must model that uncertainty rather than falsely marking the effect either definitely delivered or definitely absent. If the transport cannot provide idempotent effect submission, the contract must explicitly accept the remaining duplicate-or-loss risk; R1 command idempotency alone does not remove it.

The outbox belongs to the adapter boundary. It must not be added to R1 merely to make external delivery appear atomic with domain persistence.

## Attack 8 — concurrent reconciliation workers

**Invariant:** concurrency on Intake→R1 is already protected by R1 command idempotency; concurrency on R1→Outbox requires an adapter-owned atomic outbox claim.

Attack:
- run two reconciliation workers concurrently for the same intake;
- verify that both may safely retry the same `command_id` against R1;
- then run two workers concurrently against an `APPLIED` decision with no outbox record;
- verify that at most one worker obtains the right to send the external effect.

The first race needs no new claim mechanism: T07 already demonstrates that repeated execution of the same `command_id` yields one real result and a `REPLAYED` result. The second race is different: two workers can both observe the same `APPLIED` decision before either has created an outbox record. Therefore outbox creation must have an atomic insert-if-absent/unique-ownership step, and only the worker that successfully claims the outbox intent may call `transport.send()`.

The outbox claim protects the race before the external send. It does not resolve an ambiguous transport outcome after a send has begun; that remains the responsibility of the outbox delivery state machine.

## Attack 9 — loss between APPLIED and effect intent

**Invariant:** every `APPLIED` result that requires an external effect must eventually have a durable adapter effect intent, even if the adapter crashes after receiving `APPLIED` and before writing its own outbox record.

Attack:
- execute a command and obtain `APPLIED` from R1;
- terminate the adapter after R1 has committed but before the adapter's outbox record is durable;
- restart the adapter;
- verify that the effect is not silently lost;
- verify that recovery does not re-execute the domain command.

**Expected contract direction:** do not require cross-boundary atomicity between R1 receipt persistence and adapter outbox persistence. The adapter's normal path may write its outbox immediately after `APPLIED`, but a separate reconciliation mechanism must make the outbox **eventually complete**.

R1 therefore needs a narrow, read-only, ordered and resumable catch-up view of already accepted decisions (for example, receipts ordered by `trace_sequence`). The recovery cursor is over the full monotonic `trace_sequence`, not over a filtered APPLIED-only sequence. The stream may return only APPLIED decisions, but the cursor advances according to positions in the underlying full trace. The adapter can periodically or on startup reconcile that stream against its own outbox and create missing effect intents.

This read path does not grant the adapter authority over protocol semantics. The adapter must not use Repository/Episode reads to decide whether a command is valid, perform version checks, or mutate R1 state. It may consume an append-only stream of decisions that R1 has already made for the sole purpose of recovering its own effect bookkeeping.

The reconciliation cursor and adapter outbox remain adapter-owned durable state. R1 remains unaware of Telegram or other external transport semantics.

## Additional attack — CONFLICT without Repository read

Current R1 already returns the actual current `episode_version` on `CONFLICT`. The adapter therefore does not need direct Episode access merely to construct a retry.

Attack:
- issue a stale command;
- verify that the adapter can decide whether/how to retry using the returned result alone;
- reject any contract that requires the adapter to fetch Episode state as a normal part of this path.

## Contract questions that must be answered before implementation

1. Who creates `command_id`, and exactly when?
2. What information is transport-specific and therefore forbidden in R1 types?
3. Which `ApplicationResult` statuses may cause a new command, and which are terminal for that delivery?
4. What does the adapter do after `REJECTED`?
5. What does it do after `REPLAYED`?
6. What is the retry policy after `CONFLICT`?
7. Is an external effect ever permitted before `Application.execute()` returns `APPLIED`? Expected answer: no.
8. What durable adapter state records the lifecycle of an external effect after R1 has committed?
9. What happens if the external effect succeeds but the transport acknowledgement is lost or becomes ambiguous?
10. What happens if the external effect fails after R1 has already committed?
11. How does adapter recovery retry a pending effect without re-executing the R1 command?
12. Can the adapter ever call Repository directly for protocol decisions? The default adversarial answer should be no. Is a narrow read-only reconciliation stream of already accepted decisions the sole allowed persistence read for adapter recovery?
13. Is `REPLAYED` routed according to its surface status or according to the effective original result? Expected answer: according to `canonical_events`.
14. Which concurrency races are already covered by R1 command idempotency, and which require adapter-owned claims? Expected answer: Intake→R1 needs no new claim; R1→Outbox requires an atomic outbox claim.
15. Is the reconciliation cursor defined over the full `trace_sequence` or over a filtered APPLIED sequence? Expected answer: full `trace_sequence`.
16. Is `openEpisode()` part of the same adapter contract or a separate lifecycle operation?

## Non-goals

This review does not implement:
- Telegram integration;
- Postgres integration;
- shadow infrastructure;
- cutover;
- the adapter outbox itself;
- external effect delivery guarantees beyond what the Adapter Contract explicitly defines.

Those remain subsequent work.
