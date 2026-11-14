'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function ensureOrientationSchema(pool) {
  const schema = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { ensureOrientationSchema };
