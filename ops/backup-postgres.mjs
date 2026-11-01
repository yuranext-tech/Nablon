import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const db = process.env.BACKUP_DATABASE_URL;
const dir = process.env.BACKUP_STAGING_DIR;
if (!db || !dir) { console.error('Missing BACKUP_DATABASE_URL or BACKUP_STAGING_DIR'); process.exit(2); }
const destination = resolve(dir);
mkdirSync(destination, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(tmpdir(), 'nablon-pg-'));
const archive = join(temp, 'database.dump');
const env = { ...process.env, PGCONNECT_TIMEOUT: '15' };
const execute = (cmd, args) => {
  const result = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${cmd} failed: ${result.error?.message || result.stderr?.slice(0, 400) || result.status}`);
  return result.stdout;
};
try {
  execute('pg_dump', ['--dbname', db, '--format=custom', '--file', archive, '--no-owner', '--no-acl']);
  if (statSync(archive).size < 128) throw new Error('Dump unexpectedly small');
  execute('pg_restore', ['--list', archive]);
  const bytes = readFileSync(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + digest.slice(0, 12);
  const out = join(destination, id + '.dump');
  renameSync(archive, out);
  writeFileSync(out + '.sha256', `${digest}  ${id}.dump\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'STAGED_NOT_OFFSITE', archive: out, checksum: digest, bytes: bytes.length }));
} catch (err) {
  console.error('BACKUP_FAILED:', err.message.replaceAll(db, '[REDACTED]'));
  process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
