# Reversibility gate — operating checklist

Status: DRAFT CONTROL; not automatically enforced. Applies to Nablon and Becoming. Owner principle approved 2026-11-01.

## Asset register (fill for each service)
| Asset | Authoritative location | Recovery source | Last successful recovery test | Responsible party | Status |
|---|---|---|---|---|---|
| Nablon source | GitHub yuranext-tech/Nablon | Git history; separate mirror TBD | Not verified | Owner | PARTIAL |
| Nablon original PostgreSQL | Render ID dpg-d9opui5bedkc73dfn0t0-a | No verified backup | None | Owner | LOST/UNAVAILABLE |
| Nablon test PostgreSQL | Render ID dpg-dapdj73tqb8s73fimvo0-a | No verified backup | None | Owner | SUSPENDED |
| Becoming source | GitHub yuranext-tech/becoming | Git history; separate mirror TBD | Not verified | Owner | PARTIAL |
| Becoming runtime data | To inventory | Unknown | None | Owner | UNKNOWN |
| Architecture decision register | To approve canonical repository/path | Snapshot documents only | Not verified | Owner | DRAFT |

## Mandatory before a significant change
- [ ] Record baseline Git commit, environment and schema version
- [ ] Capture independent backup of data and deployment configuration (exclude secret values)
- [ ] Document expected changes and possible irreversible side effects
- [ ] Test rollback on an isolated environment and record output
- [ ] Obtain owner approval for destructive changes or changes without demonstrated rollback
- [ ] Verify service and data after deployment
- [ ] Record final version, evidence and rollback expiry window

## Daily checks (to automate)
- External backup exists and is fresh; verify checksum and expected file size
- Last backup timestamp <= 26 hours; alert immediately otherwise
- DB availability, expiration and quota checks
- Failure alert independent of Render service itself

## Monthly checks (to automate after prerequisites)
- Compare Git HEAD to approved decision register; distinguish divergence from legitimate owner changes
- Test restoration of a backup in a separate isolated PostgreSQL
- Validate schema, row counts, selected non-sensitive checksums and application smoke test
- Verify backup retention and privacy deletion obligations
- Report PASS/FAIL/UNKNOWN with raw evidence and remediation owner

## Stop conditions
Never label protected if backup not verified by restore. No destructive migrations without backup. No silent production changes. No restoration of user data after lawful erasure.

## Next decisions required
1. Owner approves canonical decision register and source of truth.
2. Owner chooses external encrypted backup store and cost ceiling.
3. Owner agrees recovery point (RPO) and recovery time (RTO) objectives.
