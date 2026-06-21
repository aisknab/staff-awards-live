import { conflict, forbidden, notFound } from './errors.js';
import { idText, object, optionalVersion } from './validation.js';
import { nowIso } from './utils.js';

export class VotingService {
  constructor(database) {
    this.db = database;
  }

  submit(session, raw) {
    const input = object(raw);
    const roundId = idText(input.roundId, 'roundId');
    const nomineeId = idText(input.nomineeId, 'nomineeId');
    const requestId = idText(input.requestId, 'requestId');
    const expectedRoundVersion = optionalVersion(input.expectedRoundVersion, 'expectedRoundVersion');
    const now = nowIso();

    return this.db.transaction(() => {
      const round = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
      if (!round) throw notFound('Voting round not found');
      if (round.event_id !== session.event_id) throw forbidden();
      if (round.status !== 'OPEN') throw conflict('ROUND_LOCKED', 'Voting is closed');
      if (expectedRoundVersion !== null && round.version !== expectedRoundVersion) throw conflict('CONFLICT', 'Voting state changed; refresh and try again');
      const participant = this.db.prepare("SELECT * FROM participants WHERE id = ? AND event_id = ? AND status = 'ACTIVE'").get(session.participant_id, session.event_id);
      if (!participant) throw forbidden('Participant session is inactive');
      const allowed = this.db.prepare('SELECT 1 FROM round_nominees WHERE round_id = ? AND nominee_id = ?').get(roundId, nomineeId);
      if (!allowed) throw forbidden('Nominee is not eligible for this award');
      const existing = this.db.prepare('SELECT nominee_id AS nomineeId, request_id AS requestId FROM votes WHERE round_id = ? AND participant_id = ?').get(roundId, participant.id);
      if (existing?.requestId === requestId) return { changed: false, nomineeId: existing.nomineeId, roundId };
      this.db.prepare(`
        INSERT INTO votes (round_id, participant_id, nominee_id, request_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(round_id, participant_id) DO UPDATE SET
          nominee_id = excluded.nominee_id,
          request_id = excluded.request_id,
          updated_at = excluded.updated_at
      `).run(roundId, participant.id, nomineeId, requestId, now, now);
      this.db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(now, participant.id);
      return { changed: existing?.nomineeId !== nomineeId, nomineeId, roundId };
    });
  }
}
