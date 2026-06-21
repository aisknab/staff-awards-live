import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function readInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function required(name, fallback = '') {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const publicOrigin = overrides.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8787';
  let origin;
  try {
    origin = new URL(publicOrigin).origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an absolute http(s) URL');
  }

  const databasePath = resolve(overrides.databasePath ?? process.env.DATABASE_PATH ?? './data/staff-awards.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o750 });

  const appSecret = overrides.appSecret ?? process.env.APP_SECRET ?? (isProduction ? '' : 'development-only-secret-change-me-1234567890');
  const adminPasswordHash = overrides.adminPasswordHash ?? process.env.ADMIN_PASSWORD_HASH ?? '';
  if (isProduction) {
    required('APP_SECRET', appSecret);
    required('ADMIN_PASSWORD_HASH', adminPasswordHash);
    if (!publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  }
  if (Buffer.byteLength(appSecret) < 32) throw new Error('APP_SECRET must be at least 32 bytes');

  const config = {
    nodeEnv,
    isProduction,
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port: overrides.port ?? readInt('PORT', 8787, { min: 1, max: 65535 }),
    publicOrigin: origin,
    databasePath,
    migrationsDir: resolve(overrides.migrationsDir ?? process.env.MIGRATIONS_DIR ?? './migrations'),
    publicDir: resolve(overrides.publicDir ?? process.env.PUBLIC_DIR ?? './public'),
    appSecret,
    adminUsername: overrides.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin',
    adminPasswordHash,
    adminSessionHours: overrides.adminSessionHours ?? readInt('ADMIN_SESSION_HOURS', 12, { min: 1, max: 168 }),
    participantSessionHours: overrides.participantSessionHours ?? readInt('PARTICIPANT_SESSION_HOURS', 18, { min: 1, max: 168 }),
    displaySessionHours: overrides.displaySessionHours ?? readInt('DISPLAY_SESSION_HOURS', 24, { min: 1, max: 168 }),
    trustLoopbackProxy: overrides.trustLoopbackProxy ?? readBool('TRUST_LOOPBACK_PROXY', true),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    maxBodyBytes: overrides.maxBodyBytes ?? readInt('MAX_BODY_BYTES', 32768, { min: 1024, max: 1048576 }),
    maskedMinVotes: overrides.maskedMinVotes ?? readInt('MASKED_MIN_VOTES', 3, { min: 1, max: 20 }),
    maskedMinIntervalMs: overrides.maskedMinIntervalMs ?? readInt('MASKED_MIN_INTERVAL_MS', 2000, { min: 100, max: 30000 }),
    maskedMaxDelayMs: overrides.maskedMaxDelayMs ?? readInt('MASKED_MAX_DELAY_MS', 5000, { min: 500, max: 60000 }),
    secureCookies: publicOrigin.startsWith('https://'),
  };

  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && isProduction) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Server is not bound to loopback', host: config.host }));
  }
  return Object.freeze(config);
}

export function assertSupportedNodeVersion() {
  if (process.env.NODE_ENV === 'test' || process.env.STAFF_AWARDS_SKIP_NODE_CHECK === '1') return;
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major !== 24) {
    throw new Error(`Staff Awards requires Node.js 24.x; current runtime is ${process.version}. Run \"nvm use\" first.`);
  }
}
