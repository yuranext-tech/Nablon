# Nablon — PostgreSQL data protection and recovery plan (draft, 2026-11-01)

Status: PROPOSED, NOT DEPLOYED. Owner approval required before production changes.

## Verified context
- Main Nablon on Render uses PostgreSQL via DATABASE_URL; previous primary DB dpg-d9opui5bedkc73dfn0t0-a is not accessible (404).
- Separate test service nablon-mvp-test uses another branch and a different schema.
- Recreating schema.sql does NOT recover historical rows.
- No verified restorable backup of the missing primary database has been located.

## Required protection contract
1. **External backup destination:** independent of Render; private encrypted object storage with versioning/retention, no public URLs. Select provider and billing before implementation.
2. **Scheduled logical backups:** run pg_dump in PostgreSQL custom format against the actual intended database at least once daily; upload atomically, only mark success after upload and integrity checks. Do not put backup bytes in GitHub, application logs, or Telegram.
3. **Retention:** proposed 7 daily + 4 weekly + 3 monthly backups, subject to owner approval and privacy/retention obligations.
4. **Alerting:** notify owner on first failed backup, missed backup (older than 26h), storage errors, DB unreachable, and impending database expiration. Monitoring must run outside the database and independently of the main app.
5. **Restore drill:** monthly restore to a disposable isolated PostgreSQL database, verify schema, key tables, row counts and sample checksums; never test restore on production.
6. **Secrets:** separate read-only or backup-scoped credentials where supported, stored as protected secrets; no credentials in repo, chat, URLs, logs or dumps. Restrict access and rotate credentials if exposed.
7. **Data minimization:** backups can contain Telegram IDs and verbatim responses. Define access, encryption, deletion/retention and incident handling before storing.
8. **Operational gates:** new production DB cannot be accepted until first external backup exists and an actual restore test passes. Track latest successful backup and restore timestamp in an owner-readable record.
9. **Expiration risk:** free PostgreSQL must not be treated as durable without independent backup and calendar/automated expiration warnings.

## Implementation order
A. Inventory production/test databases and exact schema per service (read-only).
B. Owner selects external storage, budget, retention and notification channel.
C. Implement backup and independent monitoring in isolated branch, with fake/test database.
D. Demonstrate backup -> upload -> restore -> data validation with raw logs (redacted).
E. Owner approves production credentials and deployment.
F. Enable schedule, verify first successful production backup and test restore.

## Current decision
No Render environment variables, databases, service deployment or production code changed by this document. No backup is running yet.
