import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso } from './utils.js';

export class Database {
  constructor(path, { migrationsDir, readOnly = false } = {}) {
    if (path !== ':memory:' && !readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.path = path;
    this.db = new DatabaseSync(path, {
      readOnly,
      enableForeignKeyConstraints: true,
      timeout: 5000,
      allowExtension: false,
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: false,
    });
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      if (migrationsDir) this.migrate(migrationsDir);
    }
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn, mode = 'IMMEDIATE') {
    this.db.exec(`BEGIN ${mode}`);
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  migrate(migrationsDir) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    if (!existsSync(migrationsDir)) throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
    const files = readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const applied = this.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?');
    const record = this.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)');
    for (const filename of files) {
      if (applied.get(filename)) continue;
      const sql = readFileSync(join(migrationsDir, filename), 'utf8');
      this.transaction(() => {
        this.db.exec(sql);
        record.run(filename, nowIso());
      }, 'EXCLUSIVE');
    }
  }

  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  }

  close() {
    this.db.close();
  }
}
