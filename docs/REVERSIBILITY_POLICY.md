# Reversibility policy — Nablon / Becoming

Status: OWNER PRINCIPLE ACCEPTED (2026-11-01); IMPLEMENTATION INCOMPLETE.
Scope: Nablon, Becoming, related pilots and their significant data, configurations, decisions and deployments.

## Rule
A significant change must have a documented and tested route back to a known-good state. When rollback is impossible, explicitly classify the operation as irreversible and require separate owner approval and risk mitigation.

## Protected assets
- PostgreSQL records, event logs, user responses, schema and migrations
- source code, release tags, deployment configurations and secret *inventory* (never store secret values in repo)
- architecture decisions, owner approvals, experiment protocols and evidence
- retention/deletion rules and required privacy erasure

## Change gate
Before production change record: asset; baseline version and commit; planned change; backup/snapshot location and timestamp; rollback steps; rollback limits; responsible person; verification result; owner approval where required.
Do not equate git revert with database rollback. Destructive migrations need tested forward repair or backup restoration.

## Recovery objectives (proposed, not agreed)
Daily backups -> up to 24 hours potential data loss; determine acceptable RPO and RTO with owner before deployment.
Independent encrypted backup store, immutable/versioned retention where available; restore test monthly.
Notify on missing backup and failed restore. Record objective evidence, not just success statements.

## Non-negotiable exceptions
Legitimate user deletion/withdrawal must propagate to retained copies according to approved retention/privacy policy; reversibility must not undo an authorized erasure.
Secret exposure requires rotation, not simply reverting a commit.
External irreversible actions (sent messages, user-visible effects) cannot be unsent: document compensating actions.

## Current implementation status
Documented only. No backups, alerts, branch protections, monthly restore drill, or automated change gate are claimed active by this file.
