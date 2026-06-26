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

  quickestJudge(eventId) {
    const rows = this.db.prepare(`
      SELECT p.id AS participantId, p.anonymous_label AS label,
             v.created_at AS votedAt, r.opened_at AS openedAt
      FROM votes v
      JOIN rounds r ON r.id = v.round_id
      JOIN participants p ON p.id = v.participant_id
      WHERE r.event_id = ?
        AND r.opened_at IS NOT NULL
        AND p.status = 'ACTIVE'
    `).all(eventId);
    const totals = new Map();
    for (const row of rows) {
      const openedAt = Date.parse(row.openedAt);
      const votedAt = Date.parse(row.votedAt);
      if (!Number.isFinite(openedAt) || !Number.isFinite(votedAt)) continue;
      const elapsedMs = Math.max(0, votedAt - openedAt);
      const existing = totals.get(row.participantId) ?? {
        participantId: row.participantId,
        label: row.label,
        totalMs: 0,
        votesCast: 0,
      };
      existing.totalMs += elapsedMs;
      existing.votesCast += 1;
      totals.set(row.participantId, existing);
    }
    const ranked = [...totals.values()]
      .map((row) => ({ ...row, averageMs: row.totalMs / row.votesCast }))
      .sort((a, b) => a.averageMs - b.averageMs || b.votesCast - a.votesCast || a.label.localeCompare(b.label));
    const winner = ranked[0] ?? null;
    return winner ? { ...winner, participantCount: ranked.length, measuredVotes: rows.length } : null;
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
    const winnerRows = rows.filter((row) => row.isWinner);
    return {
      winnerMode: winnerRows.length === 0 ? 'none' : winnerRows.length === 1 ? 'single' : 'joint',
      votesCast,
      results: rows.map((row) => revealRow(row, votesCast)),
      winners: winnerRows.map((row) => revealRow(row, votesCast)),
    };
  }


  finalDashboard(eventId) {
    const participantStats = this.db.prepare(`
      SELECT
        COUNT(*) AS totalParticipants,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) AS activeParticipants
      FROM participants
      WHERE event_id = ?
    `).get(eventId);
    const activeParticipants = Number(participantStats?.activeParticipants ?? 0);
    const totalParticipants = Number(participantStats?.totalParticipants ?? 0);
    const rows = this.db.prepare(`
      SELECT a.id AS awardId, a.title AS awardTitle, a.description AS awardDescription,
             a.sort_order AS awardSortOrder,
             r.id AS roundId, r.round_number AS roundNumber, r.status AS roundStatus,
             r.eligible_participant_count AS eligibleParticipants,
             r.opened_at AS openedAt, r.locked_at AS lockedAt,
             r.revealed_at AS revealedAt, r.completed_at AS completedAt,
             rr.nominee_id AS nomineeId, n.display_name AS name, n.subtitle,
             rr.vote_count AS count, rr.is_winner AS isWinner
      FROM awards a
      LEFT JOIN rounds r ON r.award_id = a.id AND r.event_id = a.event_id
      LEFT JOIN revealed_results rr ON rr.round_id = r.id
      LEFT JOIN nominees n ON n.id = rr.nominee_id
      WHERE a.event_id = ?
      ORDER BY a.sort_order ASC, r.round_number ASC,
               rr.is_winner DESC, rr.vote_count DESC, n.display_name COLLATE NOCASE ASC
    `).all(eventId);
    const awards = groupDashboardAwards(rows, activeParticipants);
    const completedAwards = awards.filter((award) => award.status === 'complete');
    const totalVotesCast = completedAwards.reduce((sum, award) => sum + award.votesCast, 0);
    const nomineeLeaderboard = buildNomineeLeaderboard(completedAwards);
    return {
      participantCount: activeParticipants,
      totalParticipantCount: totalParticipants,
      summary: {
        awardCount: awards.length,
        completedAwards: completedAwards.length,
        totalVotesCast,
        averageVotesPerAward: completedAwards.length ? Math.round(totalVotesCast / completedAwards.length) : 0,
        averageParticipationRate: completedAwards.length ? Math.round(completedAwards.reduce((sum, award) => sum + award.participationRate, 0) / completedAwards.length) : 0,
      },
      highlights: buildDashboardHighlights(completedAwards),
      nomineeLeaderboard,
      awards,
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


function groupDashboardAwards(rows, activeParticipants) {
  const awardsById = new Map();
  for (const row of rows) {
    let award = awardsById.get(row.awardId);
    if (!award) {
      award = {
        awardId: row.awardId,
        title: row.awardTitle,
        description: row.awardDescription,
        sortOrder: Number(row.awardSortOrder),
        rounds: new Map(),
      };
      awardsById.set(row.awardId, award);
    }
    if (!row.roundId) continue;
    let round = award.rounds.get(row.roundId);
    if (!round) {
      round = {
        roundId: row.roundId,
        roundNumber: Number(row.roundNumber),
        status: row.roundStatus,
        eligibleParticipants: Number(row.eligibleParticipants) || activeParticipants,
        openedAt: row.openedAt,
        lockedAt: row.lockedAt,
        revealedAt: row.revealedAt,
        completedAt: row.completedAt,
        rows: [],
      };
      award.rounds.set(row.roundId, round);
    }
    if (row.nomineeId) round.rows.push(row);
  }
  return [...awardsById.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
    .map((award) => dashboardAward(award, activeParticipants));
}

function dashboardAward(award, activeParticipants) {
  const finalRound = [...award.rounds.values()]
    .filter((round) => round.revealedAt)
    .sort((a, b) => b.roundNumber - a.roundNumber)[0] ?? null;
  if (!finalRound) {
    return {
      awardId: award.awardId,
      title: award.title,
      description: award.description,
      sortOrder: award.sortOrder,
      status: 'pending',
      roundId: null,
      roundNumber: null,
      votesCast: 0,
      eligibleParticipants: activeParticipants,
      participationRate: 0,
      winnerMode: 'none',
      topCount: 0,
      margin: null,
      winners: [],
      results: [],
    };
  }
  const votesCast = finalRound.rows.reduce((sum, row) => sum + Number(row.count), 0);
  const results = finalRound.rows.map((row) => revealRow(row, votesCast));
  const winners = results.filter((row) => row.isWinner);
  const topCount = winners[0]?.count ?? 0;
  const nextCount = results.find((row) => !row.isWinner)?.count ?? 0;
  const eligibleParticipants = finalRound.eligibleParticipants || activeParticipants;
  return {
    awardId: award.awardId,
    title: award.title,
    description: award.description,
    sortOrder: award.sortOrder,
    status: 'complete',
    roundId: finalRound.roundId,
    roundNumber: finalRound.roundNumber,
    openedAt: finalRound.openedAt,
    lockedAt: finalRound.lockedAt,
    revealedAt: finalRound.revealedAt,
    completedAt: finalRound.completedAt,
    votesCast,
    eligibleParticipants,
    participationRate: eligibleParticipants ? Math.round((votesCast / eligibleParticipants) * 100) : 0,
    winnerMode: winners.length === 0 ? 'none' : winners.length === 1 ? 'single' : 'joint',
    topCount,
    margin: winners.length ? Math.max(0, topCount - nextCount) : null,
    winners,
    results,
  };
}

function buildDashboardHighlights(awards) {
  const withVotes = awards.filter((award) => award.votesCast > 0);
  return {
    highestTurnout: bestOf(withVotes, (a, b) => b.participationRate - a.participationRate || b.votesCast - a.votesCast),
    closestRace: bestOf(withVotes.filter((award) => award.margin !== null), (a, b) => a.margin - b.margin || b.votesCast - a.votesCast),
    biggestWin: bestOf(withVotes.filter((award) => award.margin !== null), (a, b) => b.margin - a.margin || b.topCount - a.topCount),
  };
}

function bestOf(items, compare) {
  return [...items].sort(compare)[0] ?? null;
}

function buildNomineeLeaderboard(awards) {
  const nominees = new Map();
  for (const award of awards) {
    for (const result of award.results) {
      const nominee = nominees.get(result.nomineeId) ?? {
        nomineeId: result.nomineeId,
        name: result.name,
        subtitle: result.subtitle,
        votes: 0,
        wins: 0,
        finalistCount: 0,
      };
      nominee.votes += result.count;
      nominee.finalistCount += 1;
      if (result.isWinner) nominee.wins += 1;
      nominees.set(result.nomineeId, nominee);
    }
  }
  return [...nominees.values()]
    .sort((a, b) => b.wins - a.wins || b.votes - a.votes || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function revealRow(row, votesCast) {
  const count = Number(row.count);
  return {
    nomineeId: row.nomineeId,
    name: row.name,
    subtitle: row.subtitle,
    count,
    voteCount: count,
    percentage: votesCast ? Math.round((count / votesCast) * 100) : 0,
    isWinner: Boolean(row.isWinner),
  };
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
