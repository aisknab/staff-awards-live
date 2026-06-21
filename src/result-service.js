import { stableHashInt } from './utils.js';

export class ResultService {
  constructor(database, config) {
    this.db = database;
    this.config = config;
  }

  namedTally(roundId) {
    return this.db.prepare(`
      SELECT n.id AS nomineeId, n.display_name AS name, n.subtitle,
             COUNT(v.participant_id) AS count
      FROM round_nominees rn
      JOIN nominees n ON n.id = rn.nominee_id
      LEFT JOIN votes v ON v.round_id = rn.round_id AND v.nominee_id = rn.nominee_id
      WHERE rn.round_id = ?
      GROUP BY n.id, n.display_name, n.subtitle, n.sort_order
      ORDER BY count DESC, n.display_name COLLATE NOCASE ASC, n.subtitle COLLATE NOCASE ASC
    `).all(roundId).map((row) => ({ ...row, count: Number(row.count) }));
  }

  voteCount(roundId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM votes WHERE round_id = ?').get(roundId)?.count ?? 0);
  }

  participantCount(eventId) {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM participants WHERE event_id = ? AND status = 'ACTIVE'").get(eventId)?.count ?? 0);
  }

  publicTally(round) {
    const named = this.namedTally(round.id);
    const counts = named.map((row) => row.count).filter((count) => count > 0).sort((a, b) => b - a);
    const votesCast = counts.reduce((sum, count) => sum + count, 0);
    const visible = votesCast >= this.config.maskedMinVotes;
    return {
      roundId: round.id,
      roundVersion: round.version,
      votesCast,
      eligibleParticipants: round.eligible_participant_count || this.participantCount(round.event_id),
      counts: visible ? counts : [],
      contendersWithVotes: counts.length,
      hiddenUntilVotes: visible ? 0 : this.config.maskedMinVotes,
      leaderStatus: leaderStatus(counts, votesCast, this.config.maskedMinVotes),
      serverTime: new Date().toISOString(),
    };
  }

  winnerSummary(roundId) {
    const tally = this.namedTally(roundId);
    const topCount = tally[0]?.count ?? 0;
    const winners = topCount > 0 ? tally.filter((row) => row.count === topCount) : [];
    return { tally, topCount, winners, votesCast: tally.reduce((sum, row) => sum + row.count, 0) };
  }

  revealed(roundId) {
    const rows = this.db.prepare(`
      SELECT rr.nominee_id AS nomineeId, n.display_name AS name, n.subtitle,
             rr.vote_count AS count, rr.is_winner AS isWinner
      FROM revealed_results rr
      JOIN nominees n ON n.id = rr.nominee_id
      WHERE rr.round_id = ?
      ORDER BY rr.is_winner DESC, rr.vote_count DESC, n.display_name COLLATE NOCASE ASC
    `).all(roundId);
    const votesCast = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return {
      votesCast,
      results: rows.map((row) => ({ ...row, count: Number(row.count), isWinner: Boolean(row.isWinner) })),
      winners: rows.filter((row) => row.isWinner).map((row) => ({ nomineeId: row.nomineeId, name: row.name, subtitle: row.subtitle, count: Number(row.count) })),
    };
  }

  orderedNominees(roundId, participantId) {
    const rows = this.db.prepare(`
      SELECT n.id, n.display_name AS name, n.subtitle
      FROM round_nominees rn
      JOIN nominees n ON n.id = rn.nominee_id
      WHERE rn.round_id = ?
    `).all(roundId);
    return rows.sort((a, b) => {
      const ah = stableHashInt(`${participantId}:${roundId}:${a.id}`, this.config.appSecret);
      const bh = stableHashInt(`${participantId}:${roundId}:${b.id}`, this.config.appSecret);
      return ah - bh || a.name.localeCompare(b.name);
    });
  }
}

export function leaderStatus(counts, votesCast, minimumVotes = 3) {
  if (votesCast === 0) return 'NO_VOTES';
  if (votesCast < minimumVotes) return 'TOO_EARLY';
  const first = counts[0] ?? 0;
  const second = counts[1] ?? 0;
  if (first === second) return 'TIED';
  const lead = first - second;
  if (lead === 1) return 'VERY_CLOSE';
  if (lead === 2) return 'LEADER_EMERGING';
  return 'CLEAR_LEADER';
}
