import { conflict, forbidden, notFound } from './errors.js';
import { deriveManualCode, verifyAccessToken } from './security.js';
import { id, nowIso, safeEqualText } from './utils.js';

export class JoinService {
  constructor(database, config, sessions, eventService) {
    this.db = database;
    this.config = config;
    this.sessions = sessions;
    this.events = eventService;
  }

  eventFromJoinToken(token) {
    const event = this.eventFromCompoundToken(token);
    if (!verifyAccessToken(this.config.appSecret, 'join', token, event)) throw forbidden('Invalid or expired join link');
    return event;
  }

  eventFromDisplayToken(token) {
    const event = this.eventFromCompoundToken(token);
    if (!verifyAccessToken(this.config.appSecret, 'display', token, event)) throw forbidden('Invalid or expired display link');
    return event;
  }

  eventFromManualCode(rawCode) {
    const code = String(rawCode ?? '').normalize('NFC').trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code)) throw forbidden('Invalid event code');
    const rows = this.db.prepare("SELECT * FROM events WHERE status IN ('LOBBY','LIVE') AND join_open = 1").all();
    for (const event of rows) {
      const expected = deriveManualCode(this.config.appSecret, event.id, event.manual_code_version);
      if (safeEqualText(code, expected)) return event;
    }
    throw forbidden('Invalid or inactive event code');
  }

  eventFromCompoundToken(token) {
    if (typeof token !== 'string' || token.length > 300) throw forbidden('Invalid access link');
    const dot = token.indexOf('.');
    if (dot < 1) throw forbidden('Invalid access link');
    const eventId = token.slice(0, dot);
    const event = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw forbidden('Invalid access link');
    return event;
  }

  joinParticipant(event, existingSession = null) {
    if (existingSession?.event_id === event.id) {
      return { resumed: true, session: existingSession, cookie: null, csrfToken: existingSession.csrfToken };
    }
    if (!['LOBBY', 'LIVE'].includes(event.status) || !event.join_open) throw conflict('JOIN_CLOSED', 'Joining is closed');
    if (event.status === 'FINISHED') throw conflict('EVENT_FINISHED', 'This event has finished');

    const result = this.db.transaction(() => {
      const latest = this.db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
      if (!latest.join_open || !['LOBBY', 'LIVE'].includes(latest.status)) throw conflict('JOIN_CLOSED', 'Joining is closed');
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM participants WHERE event_id = ? AND status = 'ACTIVE'").get(event.id).count);
      if (count >= latest.participant_limit) throw conflict('PARTICIPANT_LIMIT_REACHED', 'The event is full');
      const totalJoined = Number(this.db.prepare('SELECT COUNT(*) AS count FROM participants WHERE event_id = ?').get(event.id).count);
      const participantId = id();
      const label = `Guest ${String(totalJoined + 1).padStart(2, '0')}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO participants (id, event_id, anonymous_label, status, joined_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?, NULL)
      `).run(participantId, event.id, label, timestamp, timestamp);
      const created = this.sessions.create('PARTICIPANT', { eventId: event.id, participantId });
      return { participantId, label, ...created };
    });
    return { resumed: false, ...result };
  }

  joinDisplay(event, existingSession = null) {
    if (!['LOBBY', 'LIVE', 'FINISHED'].includes(event.status)) throw conflict('DISPLAY_UNAVAILABLE', 'Open the event lobby before connecting the display');
    if (existingSession?.event_id === event.id) return { resumed: true, session: existingSession, cookie: null, csrfToken: existingSession.csrfToken };
    return { resumed: false, ...this.sessions.create('DISPLAY', { eventId: event.id }) };
  }

  revokeParticipant(eventId, participantId) {
    const participant = this.db.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?').get(participantId, eventId);
    if (!participant) throw notFound('Participant not found');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE participants SET status = 'REVOKED', revoked_at = ? WHERE id = ?").run(now, participantId);
      this.sessions.revokeParticipant(participantId);
    });
  }
}
