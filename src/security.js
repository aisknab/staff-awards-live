import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { forbidden, unauthenticated } from './errors.js';
import { safeEqualText } from './utils.js';

const scrypt = promisify(scryptCallback);
const MANUAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function securityHeaders({ api = false, sse = false } = {}) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (api || sse) headers['Cache-Control'] = 'no-store';
  return headers;
}

export function validateOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin || !safeEqualText(origin, config.publicOrigin)) {
    throw forbidden('Invalid request origin');
  }
}

export function validateCsrf(req, session, config) {
  validateOrigin(req, config);
  const supplied = req.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !safeEqualText(supplied, csrfForSession(config.appSecret, session.id))) {
    throw forbidden('Invalid CSRF token');
  }
}

export function csrfForSession(secret, sessionId) {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function deriveAccessToken(secret, purpose, eventId, version) {
  const signature = createHmac('sha256', secret).update(`${purpose}:${eventId}:${version}`).digest('base64url');
  return `${eventId}.${signature}`;
}

export function verifyAccessToken(secret, purpose, rawToken, event) {
  if (typeof rawToken !== 'string') return false;
  const dot = rawToken.indexOf('.');
  if (dot < 1) return false;
  const eventId = rawToken.slice(0, dot);
  if (eventId !== event.id) return false;
  const version = purpose === 'join' ? event.join_token_version : event.display_token_version;
  const expected = deriveAccessToken(secret, purpose, event.id, version);
  return safeEqualText(expected, rawToken);
}

export function deriveManualCode(secret, eventId, version, length = 6) {
  const digest = createHmac('sha256', secret).update(`manual:${eventId}:${version}`).digest();
  let code = '';
  for (let i = 0; i < length; i += 1) code += MANUAL_ALPHABET[digest[i] % MANUAL_ALPHABET.length];
  return code;
}

export async function hashPassword(password, options = {}) {
  const N = options.N ?? 65536;
  const r = options.r ?? 8;
  const p = options.p ?? 1;
  const keyLength = options.keyLength ?? 64;
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, keyLength, { cost: N, blockSize: r, parallelization: p, maxmem: Math.max(128 * N * r * 2, 64 * 1024 * 1024) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [scheme, nText, rText, pText, saltText, keyText] = String(encoded).split('$');
    if (scheme !== 'scrypt') return false;
    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (![N, r, p].every(Number.isInteger) || N < 1024 || r < 1 || p < 1) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    const actual = Buffer.from(await scrypt(password, salt, expected.length, { cost: N, blockSize: r, parallelization: p, maxmem: Math.max(128 * N * r * 2, 64 * 1024 * 1024) }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function requireAdminConfigured(config) {
  if (!config.adminPasswordHash) throw unauthenticated('Administrator password has not been configured');
}
