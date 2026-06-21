import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { assertSupportedNodeVersion } from '../src/config.js';

assertSupportedNodeVersion();
const input = process.argv[2];
if (!input) throw new Error('Usage: npm run restore-check -- /path/to/backup.sqlite');
const path = resolve(input);
const database = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
try {
  const integrity = database.prepare('PRAGMA integrity_check').get();
  const value = integrity?.integrity_check ?? Object.values(integrity ?? {})[0];
  if (value !== 'ok') throw new Error(`SQLite integrity check failed: ${value}`);
  const required = ['events', 'nominees', 'awards', 'rounds', 'participants', 'votes', 'sessions', 'schema_migrations'];
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set(rows.map((row) => row.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Backup is missing required tables: ${missing.join(', ')}`);
  const eventCount = Number(database.prepare('SELECT COUNT(*) AS count FROM events').get().count);
  console.log(JSON.stringify({ status: 'ok', path, eventCount }));
} finally {
  database.close();
}
