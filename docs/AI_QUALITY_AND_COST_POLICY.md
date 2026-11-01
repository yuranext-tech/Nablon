# AI quality and zero-infrastructure-spend policy

Status: OWNER APPROVED PRINCIPLES, 2026-11-01. Implementation and quality thresholds NOT YET APPROVED.

Scope: Nablon, Becoming, and related pilots.

## Owner decisions
1. No paid infrastructure, databases, object storage, hosting upgrades, or other subscriptions while product viability is unproven. Free-tier limitations must be disclosed, not concealed.
2. DeepSeek API is the sole currently permissible paid exception, subject to a separate controlled budget; this is not approval of unlimited API expenditure.
3. If adequate AI quality exceeds available budget, **reduce experiment scale rather than degrade product quality**.
4. Minimize cost of a *valid quality result*, not price per model call. Do not compromise participant comprehension, safety, experimental integrity, or user experience to reduce token cost.

## Implementation boundaries
- Deterministic experimental mechanics, counters, state transitions, and consequences belong in code, not model output.
- Model handles only explicitly permitted language tasks. Never silently change frozen experimental rules, provide prohibited hints, or substitute model judgments for observable evidence.
- Use zero-token deterministic processing when it is demonstrably adequate; use DeepSeek for tasks requiring language interpretation.
- Validate outputs against the contract. On uncertain/invalid output, use a safe fallback or explicitly request clarification; do not silently invent a result.
- Record aggregate token use and spend without leaking user messages, keys or personally identifying data into monitoring.

## Quality gate — proposed test procedure, not yet executed
- Construct representative test corpus: standard, ambiguous, off-format, confused, emotional, adversarial, long-context, multilingual responses.
- For Nablon, test invariants: no world-rule changes, no hidden-world leakage, no unsolicited solution hints, exact raw input preservation, no outcome contamination.
- Define owner-approved minimum quality thresholds before choosing cheaper model/configuration.
- Compare candidate configurations on the same corpus, including error types, latency, token count and estimated spend.
- If budget is exceeded, cap participants / sessions / experiment length rather than downgrading below threshold.

## Evidence status
No DeepSeek benchmark, real-world cost measurement, quality threshold, or production enforcement is claimed by this document.

## Related governance
See REVERSIBILITY_POLICY.md, REVERSIBILITY_GATE_CHECKLIST.md, POSTGRES_BACKUP_RECOVERY_PLAN.md in docs/.
