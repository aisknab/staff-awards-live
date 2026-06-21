import { loadConfig, assertSupportedNodeVersion } from './config.js';
import { Database } from './database.js';

assertSupportedNodeVersion();
const config = loadConfig();
const database = new Database(config.databasePath, { migrationsDir: config.migrationsDir });
database.close();
console.log('Database migrations are current.');
