import { randomUUID } from 'node:crypto';
import { AppError, badRequest } from './errors.js';
import { securityHeaders } from './security.js';

export async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw badRequest('UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json');
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('INVALID_JSON', 'Request body contains invalid JSON');
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders({ api: true }),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = String(text);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function requestId(req) {
  const existing = req.headers['x-request-id'];
  return typeof existing === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(existing) ? existing : randomUUID();
}

export function handleError(error, req, res, logger, id) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  if (error instanceof AppError) {
    const headers = error.status === 429 && error.details?.retryAfterSeconds
      ? { 'Retry-After': String(error.details.retryAfterSeconds) }
      : {};
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      requestId: id,
    }, headers);
    return;
  }
  logger.error('Unhandled request error', { requestId: id, method: req.method, path: req.url, error });
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred' }, requestId: id });
}

export function getClientIp(req, config) {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (config.trustLoopbackProxy && loopback) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length <= 200) return forwarded.split(',')[0].trim();
  }
  return remote;
}
