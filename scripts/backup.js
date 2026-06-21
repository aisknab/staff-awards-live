import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSupportedNodeVersion, loadConfig } from '../src/config.js';

assertSupportedNodeVersion();
const config = loadConfig();
const backupDir = resolve(process.env.BACKUP_DIR ?? './backups');
const retentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS ?? '14', 10);
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('BACKUP_RETENTION_DAYS must be between 1 and 3650');
mkdirSync(backupDir, { recursive: true, mode: 0o750 });
const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
const destination = join(backupDir, `staff-awards-${timestamp}.sqlite`);
const source = new DatabaseSync(config.databasePath, { readOnly: true, timeout: 5000 });
try {
  await backup(source, destination);
} finally {
  source.close();
}
const cutoff = Date.now() - retentionDays * 86400_000;
for (const filename of readdirSync(backupDir)) {
  if (!/^staff-awards-.*\.sqlite$/.test(filename)) continue;
  const path = join(backupDir, filename);
  if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
}
console.log(destination);
