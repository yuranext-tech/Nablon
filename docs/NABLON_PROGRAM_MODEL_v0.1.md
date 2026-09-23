# Nablon Program Model v0.1

Status: working design contract
Date: 2026-09-23

## 1. Architectural boundary

Nablon is the user-facing execution interface and short-lived episode runtime.

Nablon:
- presents program content;
- receives user actions/responses;
- maintains current episode state;
- executes the currently selected intervention;
- records immutable L0 events;
- exposes those events to the long-term evidence layer.

Becoming is the long-term Evidence Engine.

Becoming:
- stores and interprets accumulated evidence;
- maintains hypotheses about current processing patterns;
- evaluates signals and anti-signals;
- evaluates outcomes;
- decides whether a hypothesis remains open, needs more work, is sufficiently stable for now, or should be revisited;
- selects or recommends the next intervention/program direction.

Nablon must not become a long-term cognitive profile or autonomous evaluator of the user.

## 2. Product invariant

Nablon trains adequacy of processing.

The target is not:
- thinking more;
- checking more;
- knowing more techniques;
- maximizing analysis;
- producing a cognitive/intelligence score.

The target is the ability to notice what processing a situation requires, select an appropriate mode, perform the necessary processing, judge whether it is sufficient, and stop or switch when appropriate.

Core learning loop:

real situation -> required processing -> mode selection -> necessary operation -> action -> outcome/feedback -> changed processing.

## 3. Unit of learning

The unit of learning is a change in processing behavior, not completion of a scenario.

A scenario is a controlled carrier for testing or training a hypothesis.

Completion of an episode is not evidence of learning.

## 4. Program loop

For an area of learning:

probe -> working hypothesis -> targeted intervention -> new situations -> transfer -> signals/anti-signals -> evidence review -> next intervention.

Before a new training set, use reconnaissance whenever the current evidence is insufficient.

The probe produces a working hypothesis; it does not establish a permanent diagnosis or trait.

## 5. Hypotheses

Hypotheses are provisional.

Every meaningful hypothesis should be representable with:
- supporting evidence;
- falsifying evidence;
- next test if falsified;
- current status.

The runtime must not hard-code the current list of problem classes, processing modes, cognitive operations, or progression levels as permanent truth.

## 6. L0 event rule

Every learning-relevant interaction must produce an immutable, timestamped, versioned L0 event.

L0 events are observations, not interpretations.

Examples:
- EPISODE_STARTED
- PROBE_PRESENTED
- USER_RESPONSE
- INTERVENTION_PRESENTED
- INTERVENTION_RESPONSE
- TRANSFER_PRESENTED
- EPISODE_COMPLETED
- EPISODE_ABANDONED

An L0 event may include:
- user/session/episode identifiers;
- set/scenario identifier;
- exact presented content or stable content reference;
- exact user response;
- timestamp;
- program/content version;
- runtime version;
- relevant delivery metadata.

L0 data must remain separable from later interpretation.

## 7. Interpretation boundary

Interpretations such as:
- SIGNAL_OBSERVED
- ANTI_SIGNAL_OBSERVED
- HYPOTHESIS_UPDATED
- OUTCOME_EVALUATED
- LOOP_STATE_UPDATED
- NEXT_INTERVENTION_SELECTED

belong to the evidence/interpretation layer, not to raw user-event storage.

If interpretations are persisted, they must be explicitly marked as interpretations and must retain provenance to the L0 evidence they use.

## 8. Transfer

Transfer is evidence from a new situation where the user cannot simply replay the surface pattern of the training example.

Transfer should vary:
- surface/context;
- wording;
- apparent solution;
- cost of error;
- availability/cost of information;
- ambiguity;
- competing reasonable actions.

A correct response to a familiar scenario is weaker evidence than an appropriate processing choice in a new context.

## 9. Success and anti-success

Every intervention should define:
- intended change;
- observable success signal;
- observable anti-signal/misapplication signal;
- evidence that would falsify the intervention hypothesis.

Increasing use of an operation is not automatically progress.

Example: checking more often can represent either better calibration or a new checking ritual.

## 10. Closure

Possible working states include:

OPEN
TRAINING
VERIFYING
STABLE_FOR_NOW
NEEDS_MORE_WORK
MISAPPLICATION

These are provisional evidence states, not permanent user labels.

STABLE_FOR_NOW means current evidence no longer justifies spending additional training time there. It does not mean permanent mastery.

## 11. Progression

Difficulty must not mean only harder questions.

Complexity can increase through:
- less scaffolding;
- more ambiguity;
- competing reasonable actions;
- mixed processing requirements;
- independent mode selection;
- changed conditions;
- higher cost of error;
- higher cost of unnecessary processing;
- transfer across contexts.

## 12. Stress-test mode

The internal concept currently called Predator is a stress-test of independent mode selection.

It should not be implemented as merely the hardest question or as a test of recall of the most recently trained operation.

It may combine several previously trained demands and should test whether the user independently identifies what processing is required.

Its exact implementation remains a research hypothesis.

## 13. Research discipline

Do not infer learning from:
- episode completion;
- correctness alone;
- repetition of a trained format;
- explicit agreement with an explanation;
- increased frequency of one cognitive operation.

Do distinguish:
1. prompted execution;
2. independent execution;
3. transfer of the operation;
4. independent selection of the appropriate processing mode;
5. observed change in real behavior, where available.

## 14. Runtime design consequence

The new runtime must be content-agnostic.

Changing:
- problem maps;
- modes;
- operations;
- intervention mechanisms;
- probes;
- progression;
- transfer strategy;
- stress tests

must not require rewriting Telegram transport or the core episode runtime.

Legacy condition-change experiments remain historical content and must not define the new runtime architecture.

## 15. Primary data flow

Telegram
  -> Nablon transport/runtime
  -> immutable L0 events
  -> Becoming Evidence Engine
  -> interpretation / hypotheses / outcomes
  -> next program decision
  -> Nablon runtime

Nablon executes and records.
Becoming interprets, evaluates, and decides what accumulated evidence means.
