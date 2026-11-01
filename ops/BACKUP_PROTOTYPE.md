# Backup prototype (staging only)

This prototype runs `pg_dump` with custom format, checks `pg_restore --list`, computes SHA-256 and stages the archive locally. **No independent backup, cloud upload, scheduling or real database restore is implemented.**

Required environment: `BACKUP_DATABASE_URL`, `BACKUP_STAGING_DIR`, and installed PostgreSQL client tools. Run `node ops/backup-postgres.mjs`.

Security: keep DB URL in secret environment variables, not in repository or logs. Staging directory must be private. Do not deploy to production until an encrypted independent storage provider, retention/deletion policy and a real restore drill are approved.

Test evidence (2026-11-01): Node syntax check passed. Mocked successful pg_dump/pg_restore produced archive and SHA-256; mocked pg_dump failure returned nonzero. **No real PostgreSQL dump or restore was tested.**
