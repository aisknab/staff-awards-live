import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function id() {
  return randomUUID();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

export function hmac(secret, value, bytes = 32) {
  return createHmac('sha256', secret).update(value).digest().subarray(0, bytes).toString('base64url');
}

export function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFC').trim();
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function stableHashInt(value, secret = '') {
  const digest = createHash('sha256').update(secret).update(value).digest();
  return digest.readUInt32BE(0);
}
