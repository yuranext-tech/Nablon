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

## Attack 7 — side effect before R1 confirmation

**Invariant:** an external side effect must not be treated as proof that a command was accepted.

Attack:
- make the adapter perform an external effect before `Application.execute()` resolves;
- force R1 to return `CONFLICT`, `REJECTED`, or throw;
- verify that the contract does not define the premature effect as part of successful R1 execution.

R1 does not provide distributed transaction semantics with Telegram/UI/external systems. The contract therefore must explicitly define the adapter's ordering and failure/retry semantics instead of pretending the side effect is atomic with R1.

## Additional attack — `CONFLICT` without Repository read

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
7. What happens if an external side effect succeeds but the transport acknowledgement fails?
8. What happens if the external side effect fails after R1 has already committed?
9. Can the adapter ever call Repository directly? The default adversarial answer should be no.
10. Is `openEpisode()` part of the same adapter contract or a separate lifecycle operation?

## Non-goals

This review does not implement:
- Telegram integration;
- Postgres integration;
- shadow infrastructure;
- cutover;
- external effect delivery guarantees beyond what the Adapter Contract explicitly defines.

Those remain subsequent work.
