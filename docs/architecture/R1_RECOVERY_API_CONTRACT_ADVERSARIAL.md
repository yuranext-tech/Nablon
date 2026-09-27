# R1 Recovery API Contract — adversarial review

## Purpose

This document defines the narrow, read-only recovery interface by which the adapter can discover already accepted R1 decisions whose external effect intent may be missing.

The contract is intentionally narrower than the R1 application protocol.

R1 remains authoritative for:
- protocol validity;
- Episode mutation;
- command idempotency;
- receipts;
- monotonic `trace_sequence`;
- canonical events.

The adapter remains authoritative for:
- transport identity;
- durable intake;
- external effect reconstruction;
- outbox state;
- effect delivery;
- recovery cursor persistence.

The recovery API does not create a second event log, does not grant the adapter protocol authority, and does not make R1 responsible for external delivery.

Conceptually:

`adapter persisted cursor -> R1 recovery read -> AppliedDecision -> adapter durable effect intent -> external delivery`

## Boundary

### R1 recovery API owns

- read-only exposure of already accepted R1 decisions;
- per-Episode recovery ordering;
- full-trace cursor semantics;
- bounded scanning;
- consistent-read semantics for one response;
- reconstruction of `AppliedDecision` from the same committed R1 fact as its canonical events.

### Adapter owns

- which Episodes it needs to recover, based on its own durable intake;
- persistence of the recovery cursor;
- deciding when to call the recovery API again;
- durable capture of external effect intent;
- outbox ownership and delivery.

The adapter must not read Episode state directly to make protocol decisions or mutate R1 state. Recovery is a narrow read-only exception for already accepted decisions.

## Current topology and persistence assumptions

The current R1 implementation is in-process and synchronous. The recovery API is a read interface over R1's existing durable protocol facts.

The contract currently assumes:
- R1 receipts and canonical-event history are not pruned;
- one recovery response is evaluated against one consistent read snapshot;
- one Episode is the semantic unit of recovery;
- domain execution is single-Episode-aware: execution of one Episode does not depend on another Episode's state.

If R1 later becomes a network service, or if R1 history gains pruning, or if domain execution becomes multi-Episode-aware, this contract must be reviewed again.

## Core invariants

1. **Cursor is an exclusive lower bound.** A request with `cursor = C` considers only positions with `trace_sequence > C`. Position `C` is never returned again by that request.

2. **Recovery order is the full-trace order.** Returned decisions are ordered by ascending `trace_sequence`. The recovery stream may expose only `APPLIED` decisions, but its cursor is positioned in the complete monotonic trace, including `REJECTED` positions.

3. **One recovery position contains one AppliedDecision.** An `APPLIED` decision has one `trace_sequence` and may contain zero or more canonical events. Multiple canonical events within one decision are not separate recovery positions.

4. **Canonical-event order is explicit.** Within one `AppliedDecision`, `canonical_events` are ordered by their domain `sequence` ascending. The contract must not rely on physical storage order or database row order.

5. **`limit` bounds returned APPLIED decisions.** A response contains no more than `limit` `AppliedDecision` items. `limit` does not bound the number of trace positions inspected.

6. **`scan_limit` independently bounds work.** One call may inspect at most `scan_limit` trace positions satisfying `trace_sequence > cursor`. The call stops when either `limit` APPLIED decisions have been collected or `scan_limit` trace positions have been inspected, whichever occurs first.

7. **`next_cursor` is the scanned boundary, not an acknowledgement.** It identifies the greatest trace position actually inspected by this recovery call. It is not evidence that the adapter has durably captured every required external effect through that position. The explicit zero-scan case where `cursor > episode.trace_sequence` is an exception: the supplied cursor is preserved as `next_cursor` even though no trace position was inspected.

8. **R1 response cursor and adapter persisted cursor are distinct.** R1 returns `next_cursor`; the adapter persists its own recovery cursor only after it has completed its recovery responsibility for all APPLIED decisions covered by that advancement. In particular, an APPLIED decision must have a durable adapter effect intent before the adapter may persist progress beyond it.

9. **A REJECTED-only range may advance the response cursor.** Rejected positions create no external effect intent. Therefore a response containing no APPLIED decisions may still return `next_cursor > cursor` when the call safely scanned rejected positions.

10. **`has_more` describes the same read snapshot.** `has_more` is true exactly when the consistent read used for the response contains trace positions after `next_cursor`. It is not a promise that another APPLIED decision exists.

11. **The response is snapshot-consistent.** `items`, `next_cursor`, and `has_more` are evaluated against the same consistent read state. A command committed after that read boundary belongs to a later recovery call.

12. **Cursor beyond the current trace is idempotently empty.** If `cursor > episode.trace_sequence` for the read snapshot, the response is `items = []`, `next_cursor = cursor`, `has_more = false`. The API does not normalize the cursor backward to the current trace.

13. **Cursor equal to the current trace is an empty zero-scan case.** If `cursor === episode.trace_sequence`, there are no positions satisfying `trace_sequence > cursor`; the response is empty with `next_cursor = cursor` and `has_more = false`.

14. **Invalid cursor input is not silently repaired.** Negative, non-numeric, or otherwise malformed cursor values are protocol/input errors. R1 must not substitute the current Episode version or trace position for corrupted adapter state.

15. **Completed Episodes cannot produce future APPLIED decisions.** The structural terminal barrier on `episode.status === COMPLETED` rejects every command type before command-specific dispatch. Therefore, assuming the current barrier remains in force, no new APPLIED decision can appear after completion.

16. **Completion does not freeze trace_sequence.** A completed Episode may continue receiving commands. Those attempts are REJECTED with `episode_terminal` and still consume monotonic trace positions. Cursor retirement therefore means that the adapter stops polling the Episode; it does not mean waiting for `trace_sequence` or `has_more` to stabilize.

17. **R1 recovery history is currently non-pruned.** The contract assumes receipts and canonical-event history remain available. If R1 introduces pruning or archival that can remove positions needed to interpret a cursor, this recovery contract must be revised with explicit retired/gap semantics before pruning is enabled.

18. **Recovery is semantically single-Episode.** The public recovery contract operates on one `episode_id` and one cursor at a time. Cross-Episode independence is assumed only while R1 domain execution remains single-Episode-aware. A future multi-Episode domain model would require a new contract review.

## Recovery response

The semantic response shape is:

```ts
type AppliedDecisionBatch = {
  items: AppliedDecision[];
  next_cursor: number;
  has_more: boolean;
};
```

The request is conceptually:

```ts
listAppliedSince(
  episode_id,
  cursor,
  limit,
  scan_limit
): AppliedDecisionBatch
```

The exact TypeScript interface and repository signatures are implementation details for the subsequent implementation step. `limit` and `scan_limit` are positive finite integer bounds; malformed or non-positive values are input errors rather than silently normalized values.

### Meaning of the bounds

`limit` answers:

> How many APPLIED decisions may this response contain?

`scan_limit` answers:

> How many full-trace positions may this call inspect?

They are independent resource bounds.

For example:

```text
cursor = 10
limit = 2
scan_limit = 5

11 REJECTED
12 REJECTED
13 APPLIED
14 REJECTED
15 APPLIED
```

The response may contain decisions at 13 and 15 and return:

```text
next_cursor = 15
```

If position 16 exists in the same read snapshot:

```text
has_more = true
```

The call must not continue scanning beyond the point at which `limit` was satisfied.

Conversely:

```text
cursor = 10
limit = 2
scan_limit = 5

11 REJECTED
12 REJECTED
13 REJECTED
14 REJECTED
15 REJECTED
16 APPLIED
```

The call stops at 15 because `scan_limit` was reached:

```text
items = []
next_cursor = 15
has_more = true
```

The next call begins strictly after 15.

## Cursor progression and recovery responsibility

The distinction between the R1 response cursor and the adapter's persisted cursor is intentional.

Example:

```text
R1 trace:

101 REJECTED
102 APPLIED
103 REJECTED
104 APPLIED
105 REJECTED
```

A recovery call may return:

```text
items = [102, 104]
next_cursor = 105
has_more = false
```

The adapter cannot persist 105 merely because R1 returned it. It must first ensure that the external effect intents required by 102 and 104 are durably captured.

If the adapter crashes after capturing 102 but before capturing 104, its persisted cursor must remain at or before the last position whose recovery responsibility is complete. Re-reading 102 is safe because recovery is at-least-once and outbox creation is independently idempotent/claim-protected.

This means the recovery API is not an acknowledgement protocol between R1 and Adapter. It is a bounded read interface from which the adapter derives its own durable progress.

## Ordering

There are two independent ordering levels:

```text
Episode
  |
  | trace_sequence
  v
AppliedDecision
  |
  | canonical_event.sequence
  v
CanonicalEvent
```

Across decisions, `trace_sequence` is authoritative.

Within one decision, canonical-event `sequence` is authoritative.

No ordering guarantee is derived from:
- database insertion order;
- array position after arbitrary persistence/reconstruction;
- SQL result order without explicit `ORDER BY`.

## Empty and boundary cases

### No APPLIED decisions in scanned range

A response may be:

```text
items = []
next_cursor > cursor
has_more = true | false
```

depending on whether the scan stopped before the current snapshot end.

This is expected. A long REJECTED-only range must not be rescanned indefinitely merely because no APPLIED decision was returned.

### `cursor === trace_sequence`

No positions satisfy the exclusive lower bound. The operation is a zero-scan empty read.

### `cursor > trace_sequence`

This is also an empty read. The supplied cursor is preserved in `next_cursor` to maintain idempotent repetition of the adapter's persisted state.

### Completed Episode

After `episode.status` becomes `COMPLETED`, future commands are structurally rejected before command-specific dispatch. Therefore no future APPLIED decision can appear for that Episode.

However, rejected commands can continue to advance `trace_sequence`. Retirement of the adapter cursor therefore means:

> stop calling the recovery API for this Episode.

It does not mean:

> wait until `trace_sequence` stops changing.

## Concurrency

### Multiple recovery readers

The recovery API is read-only. Concurrent readers do not claim ownership of anything and therefore require no recovery-reader claim.

Two readers may obtain the same or different consistent snapshots depending on their invocation times. Neither creates a side effect. Duplicate observations are safe.

Ownership begins only when the adapter creates or claims a durable external effect intent.

### Command committed during a scan

A command committed after the recovery read snapshot is not part of that response. It becomes visible to a later call.

The response remains internally consistent because `items`, `next_cursor`, and `has_more` are derived from the same snapshot.

### `limit` and `scan_limit` reached together

No special result state is required. The response is determined by the positions actually inspected and the returned items. The adapter does not need to know which bound would be described as having fired first.

## Cross-Episode batching

The public semantic contract does not expose:

```text
listAppliedSinceMany(...)
```

There is no global R1 recovery cursor because `trace_sequence` is per Episode.

A future repository implementation may optimize multiple single-Episode reads into one physical database operation, for example with an internal query equivalent to:

```sql
WHERE episode_id IN (...)
```

without changing the Application-level semantics.

If such an optimization is introduced:
- each Episode retains its own cursor;
- each Episode retains its own ordering;
- there is no implied cross-Episode ordering;
- partial progress is independent per Episode;
- the optimization must remain observationally equivalent to repeated single-Episode recovery calls.

The optimization belongs below the public recovery contract, not in a second protocol method that would require a new semantic contract.

## Episode discovery and cursor lifecycle

The adapter does not need a separate R1 `listEpisodes()` recovery API.

The adapter already owns durable intake and therefore knows which Episodes participate in adapter recovery.

For a new Episode, the initial recovery cursor may be absent or represented as zero, according to the adapter persistence model.

Cursor retirement may be tied to the adapter's existing intake retention lifecycle once the adapter has a structural guarantee that no future APPLIED decision can appear for the Episode. Under the current R1 model, `COMPLETED` plus the terminal barrier supplies that guarantee.

Retirement is a cessation of polling, not a claim that the Episode's `trace_sequence` is frozen.

## Retention and future pruning

Current recovery semantics assume that R1 receipts and canonical-event history remain available.

If R1 later prunes or archives old recovery positions, the system must first define what a cursor means when its underlying positions are no longer readable.

Possible gap/retirement behavior is deliberately not specified here. The existing contract must not silently turn a missing historical position into an empty successful response, because that could make the adapter believe recovery was complete when history was actually unavailable.

Therefore:

> R1-log pruning is outside the current contract and requires a recovery-contract revision before implementation.

## Recovery guarantees and non-guarantees

The recovery API guarantees:
- ordered access to already accepted APPLIED decisions;
- full-trace cursor coordinates;
- bounded scan work;
- snapshot-consistent response metadata;
- safe repeated reads;
- deterministic boundary behavior.

It does not guarantee:
- external delivery;
- exactly-once external effects;
- outbox ownership;
- transport acknowledgement;
- that `has_more = true` implies an APPLIED decision exists;
- that `next_cursor` is safe for adapter persistence without completing effect capture.

Those responsibilities remain outside R1.

## Adversarial checks closed

The following cases are explicitly covered by the contract:

1. exclusive versus inclusive cursor boundary;
2. `limit` versus trace-position scan cost;
3. empty APPLIED result with cursor advancement;
4. cursor equal to current trace;
5. cursor beyond current trace;
6. malformed/corrupted cursor;
7. REJECTED positions interleaved with APPLIED positions;
8. multiple canonical events in one AppliedDecision;
9. explicit canonical-event ordering;
10. two concurrent recovery readers;
11. command committed during a recovery scan;
12. command committed exactly at the scan boundary;
13. command committed after `has_more` is computed;
14. `limit` and `scan_limit` terminating together;
15. completed Episode receiving further rejected commands;
16. non-pruned R1 recovery history assumption;
17. independent per-Episode cursor progression;
18. future repository-level batching without new recovery semantics.

No additional public recovery semantic is required by these attacks.

## Non-goals

This document does not implement:
- the recovery repository;
- `Application.listAppliedSince()`;
- the adapter cursor store;
- the adapter outbox;
- outbox claiming or leasing;
- external transport integration;
- global recovery ordering;
- `listAppliedSinceMany()` as a public protocol method;
- R1-log pruning or archival;
- a second R1 event log.

The next implementation step is to define the minimum read-only R1/Application/Repository interfaces required to realize this contract without expanding R1 protocol authority.
