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

## Attack 4 — adapter reads or mutates Episode

**Invariant:** the adapter must not read Episode state directly to decide protocol semantics or mutate Episode outside Application.

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
12. Can the adapter ever call Repository directly? The default adversarial answer should be no.
13. Is `openEpisode()` part of the same adapter contract or a separate lifecycle operation?

## Non-goals

This review does not implement:
- Telegram integration;
- Postgres integration;
- shadow infrastructure;
- cutover;
- the adapter outbox itself;
- external effect delivery guarantees beyond what the Adapter Contract explicitly defines.

Those remain subsequent work.
