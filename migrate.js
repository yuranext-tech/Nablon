// migrate.js — применяет schema.sql к базе при каждом запуске.
// Благодаря "IF NOT EXISTS" в schema.sql это безопасно гонять многократно:
// если таблицы уже есть, ничего не сломается и не удалится.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function runMigration() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Migration applied (schema.sql).');
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

module.exports = { runMigration };
