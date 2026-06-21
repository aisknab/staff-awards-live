import { COOKIE_NAMES, parseCookies, serializeCookie, clearCookie } from './cookies.js';
import { csrfForSession } from './security.js';
import { id, nowIso, randomToken, sha256 } from './utils.js';
import { unauthenticated, forbidden } from './errors.js';

export class SessionService {
  constructor(database, config) {
    this.db = database;
    this.config = config;
    this.insert = database.prepare(`
      INSERT INTO sessions (id, role, event_id, participant_id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    this.lookup = database.prepare(`
      SELECT s.*, p.status AS participant_status
      FROM sessions s
      LEFT JOIN participants p ON p.id = s.participant_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    `);
    this.touch = database.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?');
    this.revokeById = database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  }

  create(role, { eventId = null, participantId = null } = {}) {
    const rawToken = randomToken(32);
    const createdAt = nowIso();
    const hours = role === 'ADMIN' ? this.config.adminSessionHours : role === 'DISPLAY' ? this.config.displaySessionHours : this.config.participantSessionHours;
    const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
    const session = { id: id(), role, event_id: eventId, participant_id: participantId, created_at: createdAt, last_seen_at: createdAt, expires_at: expiresAt };
    this.insert.run(session.id, role, eventId, participantId, sha256(rawToken), createdAt, createdAt, expiresAt);
    return { session, rawToken, csrfToken: csrfForSession(this.config.appSecret, session.id), cookie: this.cookie(role, rawToken, hours * 3600) };
  }

  cookie(role, rawToken, maxAge) {
    return serializeCookie(COOKIE_NAMES[role], rawToken, { secure: this.config.secureCookies, maxAge, path: '/' });
  }

  clearCookie(role) {
    return clearCookie(COOKIE_NAMES[role], { secure: this.config.secureCookies, path: '/' });
  }

  authenticate(req, role, { optional = false } = {}) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAMES[role]];
    if (!token) {
      if (optional) return null;
      throw unauthenticated();
    }
    const session = this.lookup.get(sha256(token), nowIso());
    if (!session || session.role !== role) {
      if (optional) return null;
      throw unauthenticated('Session is missing or expired');
    }
    if (role === 'PARTICIPANT' && session.participant_status !== 'ACTIVE') throw forbidden('Participant session has been revoked');
    const threshold = new Date(Date.now() - 5 * 60_000).toISOString();
    this.touch.run(nowIso(), session.id, threshold);
    return { ...session, csrfToken: csrfForSession(this.config.appSecret, session.id) };
  }

  isActive(sessionId) {
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?").get(sessionId, nowIso()));
  }

  revoke(sessionId) {
    this.revokeById.run(nowIso(), sessionId);
  }

  revokeEventRole(eventId, role) {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE event_id = ? AND role = ? AND revoked_at IS NULL').run(nowIso(), eventId, role);
  }

  revokeParticipant(participantId) {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL').run(nowIso(), participantId);
  }
}
