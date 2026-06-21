import { badRequest, conflict, notFound } from './errors.js';
import { array, idText, integer, object, optionalVersion, text } from './validation.js';
import { deriveAccessToken, deriveManualCode } from './security.js';
import { csvCell, id, nowIso } from './utils.js';

const EVENT_STATES = ['DRAFT', 'LOBBY', 'LIVE', 'FINISHED'];
const ROUND_STATES = ['PENDING', 'PREVIEW', 'OPEN', 'LOCKED', 'REVEALED', 'COMPLETE'];

export class EventService {
  constructor(database, config, resultService, maskedTallyService = null) {
    this.db = database;
    this.config = config;
    this.results = resultService;
    this.masked = maskedTallyService;
  }

  listEvents() {
    return this.db.prepare(`
      SELECT id, title, subtitle, status, participant_limit AS participantLimit,
             join_open AS joinOpen, version, created_at AS createdAt,
             updated_at AS updatedAt, finished_at AS finishedAt
      FROM events
      ORDER BY CASE status WHEN 'LIVE' THEN 0 WHEN 'LOBBY' THEN 1 WHEN 'DRAFT' THEN 2 ELSE 3 END,
               updated_at DESC
    `).all().map(normaliseBooleans);
  }

  getEvent(eventId) {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!row) throw notFound('Event not found');
    return row;
  }

  getRound(roundId) {
    if (!roundId) return null;
    return this.db.prepare(`
      SELECT r.*, a.title AS award_title, a.description AS award_description, a.sort_order AS award_sort_order
      FROM rounds r JOIN awards a ON a.id = r.award_id WHERE r.id = ?
    `).get(roundId) ?? null;
  }

  getCurrentRound(event) {
    return event.active_round_id ? this.getRound(event.active_round_id) : null;
  }

  saveConfig(raw) {
    const input = validateConfig(raw);
    const existing = input.eventId ? this.getEvent(input.eventId) : null;
    if (existing && existing.status !== 'DRAFT') throw conflict('CONFIG_LOCKED', 'Event configuration is locked after the lobby opens');
    if (existing && input.expectedEventVersion !== null && existing.version !== input.expectedEventVersion) {
      throw conflict('CONFLICT', 'Event was changed by another admin tab');
    }

    const eventId = existing?.id ?? id();
    const timestamp = nowIso();
    const nomineeIds = new Map(input.nominees.map((nominee) => [nominee.key, id()]));

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(`
          UPDATE events SET title = ?, subtitle = ?, participant_limit = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'DRAFT'
        `).run(input.title, input.subtitle, input.participantLimit, timestamp, eventId);
        this.db.prepare('DELETE FROM awards WHERE event_id = ?').run(eventId);
        this.db.prepare('DELETE FROM nominees WHERE event_id = ?').run(eventId);
      } else {
        this.db.prepare(`
          INSERT INTO events (
            id, title, subtitle, status, active_round_id, participant_limit, join_open,
            display_blanked, join_token_version, display_token_version, manual_code_version,
            version, created_at, updated_at, finished_at
          ) VALUES (?, ?, ?, 'DRAFT', NULL, ?, 0, 0, 1, 1, 1, 1, ?, ?, NULL)
        `).run(eventId, input.title, input.subtitle, input.participantLimit, timestamp, timestamp);
      }

      const insertNominee = this.db.prepare(`
        INSERT INTO nominees (id, event_id, display_name, subtitle, sort_order, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `);
      input.nominees.forEach((nominee, index) => {
        insertNominee.run(nomineeIds.get(nominee.key), eventId, nominee.displayName, nominee.subtitle, index, timestamp, timestamp);
      });

      const insertAward = this.db.prepare(`
        INSERT INTO awards (id, event_id, title, description, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAwardNominee = this.db.prepare('INSERT INTO award_nominees (award_id, nominee_id) VALUES (?, ?)');
      input.awards.forEach((award, index) => {
        const awardId = id();
        insertAward.run(awardId, eventId, award.title, award.description, index, timestamp, timestamp);
        for (const key of award.eligibleNomineeKeys) insertAwardNominee.run(awardId, nomineeIds.get(key));
      });
      this.audit(eventId, existing ? 'CONFIG_UPDATED' : 'EVENT_CREATED', { awardCount: input.awards.length, nomineeCount: input.nominees.length });
    });

    return this.getAdminEvent(eventId);
  }

  getAdminEvent(eventId) {
    const event = this.getEvent(eventId);
    const nominees = this.db.prepare(`
      SELECT id, display_name AS displayName, subtitle, sort_order AS sortOrder, active
      FROM nominees WHERE event_id = ? ORDER BY sort_order
    `).all(eventId).map(normaliseBooleans);
    const awards = this.db.prepare(`
      SELECT id, title, description, sort_order AS sortOrder
      FROM awards WHERE event_id = ? ORDER BY sort_order
    `).all(eventId);
    const eligible = this.db.prepare('SELECT nominee_id AS nomineeId FROM award_nominees WHERE award_id = ?');
    for (const award of awards) award.eligibleNomineeIds = eligible.all(award.id).map((row) => row.nomineeId);
    const round = this.getCurrentRound(event);
    return {
      id: event.id,
      title: event.title,
      subtitle: event.subtitle,
      status: event.status,
      participantLimit: event.participant_limit,
      joinOpen: Boolean(event.join_open),
      displayBlanked: Boolean(event.display_blanked),
      version: event.version,
      nominees,
      awards,
      currentRound: round ? this.adminRound(round) : null,
      access: this.accessDetails(event),
    };
  }

  accessDetails(event) {
    const joinToken = deriveAccessToken(this.config.appSecret, 'join', event.id, event.join_token_version);
    const displayToken = deriveAccessToken(this.config.appSecret, 'display', event.id, event.display_token_version);
    return {
      joinUrl: `${this.config.publicOrigin}/#join/${joinToken}`,
      displayUrl: `${this.config.publicOrigin}/display#display/${displayToken}`,
      manualCode: deriveManualCode(this.config.appSecret, event.id, event.manual_code_version),
    };
  }

  participantState(session) {
    const event = this.getEvent(session.event_id);
    const round = this.getCurrentRound(event);
    const participant = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(session.participant_id);
    const progress = this.progress(event.id);
    const state = {
      role: 'PARTICIPANT',
      event: publicEvent(event),
      participant: { id: participant.id, label: participant.anonymous_label },
      progress,
      round: null,
    };
    if (!round) return state;
    const ownVote = this.db.prepare('SELECT nominee_id AS nomineeId FROM votes WHERE round_id = ? AND participant_id = ?').get(round.id, participant.id) ?? null;
    state.round = {
      id: round.id,
      status: round.status,
      version: round.version,
      roundNumber: round.round_number,
      award: { id: round.award_id, title: round.award_title, description: round.award_description },
      nominees: ['PREVIEW', 'OPEN', 'LOCKED'].includes(round.status) ? this.results.orderedNominees(round.id, participant.id) : [],
      ownVote,
      maskedTally: ownVote || ['LOCKED', 'REVEALED', 'COMPLETE'].includes(round.status) ? (this.masked?.get(round) ?? this.results.publicTally(round)) : publicProgressOnly(this.masked?.get(round) ?? this.results.publicTally(round)),
      revealed: ['REVEALED', 'COMPLETE'].includes(round.status) ? this.results.revealed(round.id) : null,
    };
    return state;
  }

  displayState(session) {
    const event = this.getEvent(session.event_id);
    const round = this.getCurrentRound(event);
    return {
      role: 'DISPLAY',
      event: publicEvent(event),
      progress: this.progress(event.id),
      join: { manualCode: this.accessDetails(event).manualCode, qrUrl: '/api/display/join-qr.svg' },
      round: round ? {
        id: round.id,
        status: round.status,
        version: round.version,
        roundNumber: round.round_number,
        award: { id: round.award_id, title: round.award_title, description: round.award_description },
        maskedTally: this.masked?.get(round) ?? this.results.publicTally(round),
        revealed: ['REVEALED', 'COMPLETE'].includes(round.status) ? this.results.revealed(round.id) : null,
      } : null,
    };
  }

  adminState(eventId) {
    const event = this.getEvent(eventId);
    const round = this.getCurrentRound(event);
    const participants = this.db.prepare(`
      SELECT id, anonymous_label AS label, status, joined_at AS joinedAt,
             last_seen_at AS lastSeenAt, revoked_at AS revokedAt
      FROM participants WHERE event_id = ? ORDER BY joined_at ASC
    `).all(eventId);
    return {
      event: this.getAdminEvent(eventId),
      progress: this.progress(eventId),
      participants,
      namedTally: round ? {
        roundId: round.id,
        votesCast: this.results.voteCount(round.id),
        results: this.results.namedTally(round.id),
      } : null,
    };
  }

  progress(eventId) {
    const registered = Number(this.db.prepare("SELECT COUNT(*) AS count FROM participants WHERE event_id = ? AND status = 'ACTIVE'").get(eventId)?.count ?? 0);
    const event = this.getEvent(eventId);
    const voted = event.active_round_id ? this.results.voteCount(event.active_round_id) : 0;
    const awardCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM awards WHERE event_id = ?').get(eventId)?.count ?? 0);
    const completedAwards = Number(this.db.prepare(`
      SELECT COUNT(DISTINCT award_id) AS count FROM rounds
      WHERE event_id = ? AND completed_at IS NOT NULL AND revealed_at IS NOT NULL
    `).get(eventId)?.count ?? 0);
    return { registeredParticipants: registered, votesCast: voted, awardCount, completedAwards };
  }

  adminRound(round) {
    return {
      id: round.id,
      awardId: round.award_id,
      parentRoundId: round.parent_round_id,
      roundNumber: round.round_number,
      status: round.status,
      version: round.version,
      award: { title: round.award_title, description: round.award_description, sortOrder: round.award_sort_order },
      openedAt: round.opened_at,
      lockedAt: round.locked_at,
      revealedAt: round.revealed_at,
      completedAt: round.completed_at,
    };
  }

  listPeopleLists() {
    const lists = this.db.prepare(`
      SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
      FROM people_lists
      ORDER BY updated_at DESC, name ASC
    `).all();
    if (!lists.length) return [];

    const rows = this.db.prepare(`
      SELECT list_id AS listId, display_name AS displayName, subtitle, sort_order AS sortOrder
      FROM people_list_entries
      ORDER BY list_id, sort_order
    `).all();
    const entriesByList = new Map();
    for (const row of rows) {
      const entries = entriesByList.get(row.listId) ?? [];
      entries.push({ displayName: row.displayName, subtitle: row.subtitle });
      entriesByList.set(row.listId, entries);
    }
    return lists.map((list) => ({ ...list, entries: entriesByList.get(list.id) ?? [] }));
  }

  savePeopleList(raw) {
    const input = validatePeopleList(raw);
    if (input.listId) {
      const existing = this.db.prepare('SELECT id FROM people_lists WHERE id = ?').get(input.listId);
      if (!existing) throw notFound('People list not found');
    }
    const duplicate = this.db.prepare('SELECT id FROM people_lists WHERE lower(name) = lower(?) AND id <> ?').get(input.name, input.listId ?? '');
    if (duplicate) throw conflict('PEOPLE_LIST_EXISTS', 'A people list with that name already exists');

    const listId = input.listId ?? id();
    const timestamp = nowIso();
    this.db.transaction(() => {
      if (input.listId) {
        this.db.prepare('UPDATE people_lists SET name = ?, updated_at = ? WHERE id = ?').run(input.name, timestamp, listId);
        this.db.prepare('DELETE FROM people_list_entries WHERE list_id = ?').run(listId);
      } else {
        this.db.prepare('INSERT INTO people_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(listId, input.name, timestamp, timestamp);
      }
      const insert = this.db.prepare(`
        INSERT INTO people_list_entries (list_id, display_name, subtitle, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      input.entries.forEach((entry, index) => insert.run(listId, entry.displayName, entry.subtitle, index));
      this.audit(null, input.listId ? 'PEOPLE_LIST_UPDATED' : 'PEOPLE_LIST_CREATED', { listId, entryCount: input.entries.length });
    });
    return this.listPeopleLists();
  }

  deletePeopleList(raw) {
    const input = object(raw);
    const listId = idText(input.listId ?? input.id, 'listId');
    const existing = this.db.prepare('SELECT id FROM people_lists WHERE id = ?').get(listId);
    if (!existing) throw notFound('People list not found');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM people_lists WHERE id = ?').run(listId);
      this.audit(null, 'PEOPLE_LIST_DELETED', { listId });
    });
    return this.listPeopleLists();
  }

  performAction(eventId, raw, actorRole = 'ADMIN') {
    const input = object(raw);
    const action = text(input.action, 'action', { max: 50 });
    const expectedEventVersion = optionalVersion(input.expectedEventVersion, 'expectedEventVersion');
    const expectedRoundVersion = optionalVersion(input.expectedRoundVersion, 'expectedRoundVersion');
    const event = this.getEvent(eventId);
    if (expectedEventVersion !== null && event.version !== expectedEventVersion) throw conflict('CONFLICT', 'Event state is stale');
    const round = this.getCurrentRound(event);
    if (round && expectedRoundVersion !== null && round.version !== expectedRoundVersion) throw conflict('CONFLICT', 'Round state is stale');

    const handlers = {
      OPEN_LOBBY: () => this.openLobby(event),
      CLOSE_JOINS: () => this.setJoins(event, false),
      REOPEN_JOINS: () => this.setJoins(event, true),
      SHOW_AWARD: () => this.showAward(event),
      OPEN_VOTING: () => this.openVoting(event, round),
      LOCK_VOTING: () => this.lockVoting(event, round),
      REOPEN_VOTING: () => this.reopenVoting(event, round),
      REVEAL_WINNER: () => this.reveal(event, round, false),
      REVEAL_JOINT_WINNERS: () => this.reveal(event, round, true),
      START_RUNOFF: () => this.startRunoff(event, round),
      NEXT_AWARD: () => this.nextAward(event, round),
      BLANK_DISPLAY: () => this.setBlanked(event, true),
      UNBLANK_DISPLAY: () => this.setBlanked(event, false),
      FINISH_EVENT: () => this.finishEvent(event),
      REOPEN_EVENT: () => this.reopenEvent(event),
      RESTART_EVENT: () => this.restartEvent(event),
      RESET_CURRENT_ROUND: () => this.resetRound(event, round),
      ROTATE_JOIN_TOKEN: () => this.rotateToken(event, 'join'),
      ROTATE_DISPLAY_TOKEN: () => this.rotateToken(event, 'display'),
    };
    const handler = handlers[action];
    if (!handler) throw badRequest('UNKNOWN_ACTION', 'Unknown admin action');
    handler();
    this.audit(eventId, action, { actorRole, roundId: round?.id ?? null });
    return this.adminState(eventId);
  }

  openLobby(event) {
    if (event.status !== 'DRAFT') throw conflict('INVALID_STATE_TRANSITION', 'Only draft events can open the lobby');
    this.requireNoOtherActiveEvent(event);
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM awards WHERE event_id = ?) AS awards,
      (SELECT COUNT(*) FROM nominees WHERE event_id = ?) AS nominees
    `).get(event.id, event.id);
    if (Number(counts.awards) < 1 || Number(counts.nominees) < 2) throw conflict('INCOMPLETE_EVENT', 'Add at least one award and two nominees before opening the lobby');
    const now = nowIso();
    this.db.prepare(`UPDATE events SET status = 'LOBBY', join_open = 1, version = version + 1, updated_at = ? WHERE id = ? AND status = 'DRAFT'`).run(now, event.id);
  }

  setJoins(event, open) {
    if (!['LOBBY', 'LIVE'].includes(event.status)) throw conflict('INVALID_STATE_TRANSITION', 'Joining can only change for an active event');
    this.db.prepare('UPDATE events SET join_open = ?, version = version + 1, updated_at = ? WHERE id = ?').run(open ? 1 : 0, nowIso(), event.id);
  }

  showAward(event) {
    if (!['LOBBY', 'LIVE'].includes(event.status)) throw conflict('INVALID_STATE_TRANSITION', 'Open the lobby first');
    if (event.active_round_id) throw conflict('INVALID_STATE_TRANSITION', 'An award is already active');
    this.db.transaction(() => {
      const award = this.nextIncompleteAward(event.id);
      if (!award) throw conflict('NO_MORE_AWARDS', 'There are no remaining awards');
      const nomineeIds = this.db.prepare('SELECT nominee_id AS nomineeId FROM award_nominees WHERE award_id = ?').all(award.id).map((row) => row.nomineeId);
      const round = this.createRound(event.id, award.id, null, nomineeIds, 'PREVIEW');
      this.db.prepare('UPDATE events SET active_round_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(round.id, nowIso(), event.id);
    });
  }

  openVoting(event, round) {
    if (!['LOBBY', 'LIVE'].includes(event.status)) throw conflict('INVALID_STATE_TRANSITION', 'The event is not active');
    requireRound(round);
    if (round.status !== 'PREVIEW') throw conflict('INVALID_STATE_TRANSITION', 'Only a preview round can open for voting');
    const now = nowIso();
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE rounds SET status = 'OPEN', version = version + 1, opened_at = ? WHERE id = ? AND status = 'PREVIEW'`).run(now, round.id);
      if (Number(result.changes) !== 1) throw conflict('CONFLICT', 'Round state changed');
      this.db.prepare(`UPDATE events SET status = 'LIVE', version = version + 1, updated_at = ? WHERE id = ?`).run(now, event.id);
    });
  }

  lockVoting(event, round) {
    if (event.status !== 'LIVE') throw conflict('INVALID_STATE_TRANSITION', 'The event is not live');
    requireRound(round);
    if (round.status !== 'OPEN') throw conflict('INVALID_STATE_TRANSITION', 'Voting is not open');
    const now = nowIso();
    const eligible = this.results.participantCount(event.id);
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE rounds SET status = 'LOCKED', version = version + 1, locked_at = ?, eligible_participant_count = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(now, eligible, round.id);
      if (Number(result.changes) !== 1) throw conflict('CONFLICT', 'Round state changed');
      this.db.prepare('UPDATE events SET version = version + 1, updated_at = ? WHERE id = ?').run(now, event.id);
    });
  }

  reopenVoting(event, round) {
    if (event.status !== 'LIVE') throw conflict('INVALID_STATE_TRANSITION', 'The event is not live');
    requireRound(round);
    if (round.status !== 'LOCKED' || round.revealed_at) throw conflict('INVALID_STATE_TRANSITION', 'Only an unrevealed locked round can reopen');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE rounds SET status = 'OPEN', version = version + 1, locked_at = NULL WHERE id = ? AND status = 'LOCKED'`).run(round.id);
      this.db.prepare('UPDATE events SET version = version + 1, updated_at = ? WHERE id = ?').run(now, event.id);
    });
  }

  reveal(event, round, allowJoint) {
    if (event.status !== 'LIVE') throw conflict('INVALID_STATE_TRANSITION', 'The event is not live');
    requireRound(round);
    if (round.status !== 'LOCKED') throw conflict('INVALID_STATE_TRANSITION', 'Lock voting before revealing');
    const summary = this.results.winnerSummary(round.id);
    if (summary.winners.length > 1 && !allowJoint) {
      throw conflict('TIE_REQUIRES_DECISION', 'The top result is tied. Reveal joint winners or start a runoff.', { tiedNominees: summary.winners.length });
    }
    if (allowJoint && summary.winners.length < 2) throw conflict('NOT_TIED', 'The result is not tied');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM revealed_results WHERE round_id = ?').run(round.id);
      const insert = this.db.prepare(`INSERT INTO revealed_results (round_id, nominee_id, vote_count, is_winner, created_at) VALUES (?, ?, ?, ?, ?)`);
      const winnerIds = new Set(summary.winners.map((winner) => winner.nomineeId));
      for (const row of summary.tally) insert.run(round.id, row.nomineeId, row.count, winnerIds.has(row.nomineeId) ? 1 : 0, now);
      this.db.prepare(`UPDATE rounds SET status = 'REVEALED', version = version + 1, revealed_at = ? WHERE id = ? AND status = 'LOCKED'`).run(now, round.id);
      this.db.prepare('UPDATE events SET version = version + 1, updated_at = ? WHERE id = ?').run(now, event.id);
    });
  }

  startRunoff(event, round) {
    if (event.status !== 'LIVE') throw conflict('INVALID_STATE_TRANSITION', 'The event is not live');
    requireRound(round);
    if (round.status !== 'LOCKED') throw conflict('INVALID_STATE_TRANSITION', 'Lock voting before starting a runoff');
    const summary = this.results.winnerSummary(round.id);
    if (summary.winners.length < 2) throw conflict('NOT_TIED', 'A runoff requires a tied top result');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE rounds SET status = 'COMPLETE', version = version + 1, completed_at = ? WHERE id = ? AND status = 'LOCKED'`).run(now, round.id);
      const newRound = this.createRound(event.id, round.award_id, round.id, summary.winners.map((winner) => winner.nomineeId), 'PREVIEW');
      this.db.prepare('UPDATE events SET active_round_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(newRound.id, now, event.id);
    });
  }

  nextAward(event, round) {
    if (event.status !== 'LIVE') throw conflict('INVALID_STATE_TRANSITION', 'The event is not live');
    requireRound(round);
    if (round.status !== 'REVEALED') throw conflict('INVALID_STATE_TRANSITION', 'Reveal the result before moving on');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE rounds SET status = 'COMPLETE', version = version + 1, completed_at = ? WHERE id = ? AND status = 'REVEALED'`).run(now, round.id);
      const next = this.nextIncompleteAward(event.id);
      if (!next) {
        this.db.prepare(`UPDATE events SET status = 'FINISHED', join_open = 0, active_round_id = NULL, version = version + 1, updated_at = ?, finished_at = ? WHERE id = ?`).run(now, now, event.id);
      } else {
        const nomineeIds = this.db.prepare('SELECT nominee_id AS nomineeId FROM award_nominees WHERE award_id = ?').all(next.id).map((row) => row.nomineeId);
        const newRound = this.createRound(event.id, next.id, null, nomineeIds, 'PREVIEW');
        this.db.prepare('UPDATE events SET active_round_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(newRound.id, now, event.id);
      }
    });
  }

  finishEvent(event) {
    if (event.status === 'FINISHED') return;
    if (!['LOBBY', 'LIVE'].includes(event.status)) throw conflict('INVALID_STATE_TRANSITION', 'Only an active event can be finished');
    const round = this.getCurrentRound(event);
    if (round && ['OPEN', 'LOCKED'].includes(round.status)) throw conflict('INVALID_STATE_TRANSITION', 'Close or resolve the current voting round before finishing');
    const now = nowIso();
    this.db.transaction(() => {
      if (round && round.status !== 'COMPLETE') {
        this.db.prepare(`UPDATE rounds SET status = 'COMPLETE', version = version + 1, completed_at = COALESCE(completed_at, ?) WHERE id = ?`).run(now, round.id);
      }
      this.db.prepare(`
        UPDATE events SET status = 'FINISHED', join_open = 0, active_round_id = NULL,
          version = version + 1, updated_at = ?, finished_at = ? WHERE id = ?
      `).run(now, now, event.id);
    });
  }

  reopenEvent(event) {
    if (event.status !== 'FINISHED') throw conflict('INVALID_STATE_TRANSITION', 'Only finished events can be reopened');
    this.requireNoOtherActiveEvent(event);
    const now = nowIso();
    const round = this.roundFromLatestManualFinish(event.id);
    const status = round && (round.opened_at || round.revealed_at || this.hasOpenedRounds(event.id, round.id)) ? 'LIVE' : 'LOBBY';
    const roundStatus = round?.revealed_at ? 'REVEALED' : 'PREVIEW';
    this.db.transaction(() => {
      if (round) {
        this.db.prepare(`
          UPDATE rounds SET status = ?, version = version + 1, completed_at = NULL
          WHERE id = ? AND event_id = ? AND status = 'COMPLETE'
        `).run(roundStatus, round.id, event.id);
      }
      this.db.prepare(`
        UPDATE events SET status = ?, join_open = 1, active_round_id = ?,
          display_blanked = 0, version = version + 1, updated_at = ?, finished_at = NULL
        WHERE id = ? AND status = 'FINISHED'
      `).run(status, round?.id ?? null, now, event.id);
    });
  }

  restartEvent(event) {
    if (event.status !== 'FINISHED') throw conflict('INVALID_STATE_TRANSITION', 'Only finished events can be restarted');
    this.requireNoOtherActiveEvent(event);
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM rounds WHERE event_id = ?').run(event.id);
      this.db.prepare('DELETE FROM participants WHERE event_id = ?').run(event.id);
      this.db.prepare(`
        UPDATE events SET status = 'LOBBY', join_open = 1, active_round_id = NULL,
          display_blanked = 0, version = version + 1, updated_at = ?, finished_at = NULL
        WHERE id = ? AND status = 'FINISHED'
      `).run(now, event.id);
    });
  }

  setBlanked(event, blanked) {
    if (!['LOBBY', 'LIVE'].includes(event.status)) throw conflict('INVALID_STATE_TRANSITION', 'The display can only be blanked during an active event');
    this.db.prepare('UPDATE events SET display_blanked = ?, version = version + 1, updated_at = ? WHERE id = ?').run(blanked ? 1 : 0, nowIso(), event.id);
  }

  resetRound(event, round) {
    requireRound(round);
    if (['REVEALED', 'COMPLETE'].includes(round.status)) throw conflict('INVALID_STATE_TRANSITION', 'A revealed or completed round cannot be reset');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM votes WHERE round_id = ?').run(round.id);
      this.db.prepare('DELETE FROM revealed_results WHERE round_id = ?').run(round.id);
      this.db.prepare(`UPDATE rounds SET status = 'PREVIEW', version = version + 1, opened_at = NULL, locked_at = NULL, revealed_at = NULL, eligible_participant_count = 0 WHERE id = ?`).run(round.id);
      this.db.prepare('UPDATE events SET version = version + 1, updated_at = ? WHERE id = ?').run(now, event.id);
    });
  }

  rotateToken(event, purpose) {
    const field = purpose === 'join' ? 'join_token_version' : 'display_token_version';
    const manual = purpose === 'join' ? ', manual_code_version = manual_code_version + 1' : '';
    this.db.prepare(`UPDATE events SET ${field} = ${field} + 1 ${manual}, version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), event.id);
  }

  requireNoOtherActiveEvent(event) {
    const active = this.db.prepare("SELECT id FROM events WHERE status IN ('LOBBY','LIVE') AND id <> ? LIMIT 1").get(event.id);
    if (active) throw conflict('ACTIVE_EVENT_EXISTS', 'Another event is already active');
  }

  roundFromLatestManualFinish(eventId) {
    const row = this.db.prepare(`
      SELECT action, metadata_json AS metadataJson
      FROM audit_log
      WHERE event_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(eventId);
    if (row?.action !== 'FINISH_EVENT') return null;
    let metadata;
    try { metadata = JSON.parse(row.metadataJson); } catch { return null; }
    if (!metadata?.roundId) return null;
    const round = this.getRound(metadata.roundId);
    return round?.event_id === eventId && round.status === 'COMPLETE' ? round : null;
  }

  hasOpenedRounds(eventId, excludeRoundId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM rounds
      WHERE event_id = ? AND id <> ? AND opened_at IS NOT NULL
    `).get(eventId, excludeRoundId);
    return Number(row?.count ?? 0) > 0;
  }

  nextIncompleteAward(eventId) {
    return this.db.prepare(`
      SELECT a.* FROM awards a
      WHERE a.event_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM rounds r
          WHERE r.award_id = a.id AND r.completed_at IS NOT NULL AND r.revealed_at IS NOT NULL
        )
      ORDER BY a.sort_order ASC
      LIMIT 1
    `).get(eventId) ?? null;
  }

  createRound(eventId, awardId, parentRoundId, nomineeIds, status) {
    const roundId = id();
    const row = this.db.prepare('SELECT COALESCE(MAX(round_number), 0) + 1 AS number FROM rounds WHERE award_id = ?').get(awardId);
    const roundNumber = Number(row.number);
    this.db.prepare(`
      INSERT INTO rounds (id, event_id, award_id, parent_round_id, round_number, status, version, eligible_participant_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
    `).run(roundId, eventId, awardId, parentRoundId, roundNumber, status, nowIso());
    const insert = this.db.prepare('INSERT INTO round_nominees (round_id, nominee_id) VALUES (?, ?)');
    for (const nomineeId of nomineeIds) insert.run(roundId, nomineeId);
    return { id: roundId, roundNumber };
  }

  audit(eventId, action, metadata = {}) {
    this.db.prepare(`INSERT INTO audit_log (id, event_id, action, actor_role, metadata_json, created_at) VALUES (?, ?, ?, 'ADMIN', ?, ?)`)
      .run(id(), eventId, action, JSON.stringify(metadata), nowIso());
  }

  exportCsv(eventId) {
    const event = this.getEvent(eventId);
    const rows = this.db.prepare(`
      SELECT a.title AS award, r.round_number AS roundNumber, n.display_name AS nominee,
             rr.vote_count AS voteCount, rr.is_winner AS winner,
             r.opened_at AS openedAt, r.locked_at AS lockedAt, r.revealed_at AS revealedAt
      FROM rounds r
      JOIN awards a ON a.id = r.award_id
      JOIN revealed_results rr ON rr.round_id = r.id
      JOIN nominees n ON n.id = rr.nominee_id
      WHERE r.event_id = ?
      ORDER BY a.sort_order, r.round_number, rr.vote_count DESC, n.display_name
    `).all(eventId);
    const lines = [['Event', 'Award', 'Round', 'Nominee', 'Vote count', 'Percentage', 'Winner', 'Opened time', 'Locked time', 'Revealed time']];
    const totals = new Map();
    for (const row of rows) {
      const key = `${row.award}:${row.roundNumber}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(row.voteCount));
    }
    for (const row of rows) {
      const total = totals.get(`${row.award}:${row.roundNumber}`) || 0;
      lines.push([event.title, row.award, row.roundNumber, row.nominee, row.voteCount, total ? `${((Number(row.voteCount) / total) * 100).toFixed(1)}%` : '0%', row.winner ? 'Yes' : 'No', row.openedAt ?? '', row.lockedAt ?? '', row.revealedAt ?? '']);
    }
    return lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

function validateConfig(raw) {
  const input = object(raw);
  const nomineesRaw = array(input.nominees, 'nominees', { min: 2, max: 100 });
  const nominees = nomineesRaw.map((rawNominee, index) => {
    const nominee = object(rawNominee, `nominees[${index}]`);
    return {
      key: idText(nominee.key, `nominees[${index}].key`),
      displayName: text(nominee.displayName, `nominees[${index}].displayName`, { max: 100 }),
      subtitle: text(nominee.subtitle ?? '', `nominees[${index}].subtitle`, { required: false, max: 100 }),
    };
  });
  const keys = new Set();
  const names = new Set();
  for (const nominee of nominees) {
    if (keys.has(nominee.key)) throw badRequest('VALIDATION_ERROR', 'Nominee keys must be unique');
    keys.add(nominee.key);
    const identity = `${nominee.displayName.toLocaleLowerCase()}:${nominee.subtitle.toLocaleLowerCase()}`;
    if (names.has(identity)) throw badRequest('VALIDATION_ERROR', `Duplicate nominee: ${nominee.displayName}`);
    names.add(identity);
  }
  const awardsRaw = array(input.awards, 'awards', { min: 1, max: 100 });
  const awards = awardsRaw.map((rawAward, index) => {
    const award = object(rawAward, `awards[${index}]`);
    const eligible = array(award.eligibleNomineeKeys, `awards[${index}].eligibleNomineeKeys`, { min: 2, max: 100 }).map((key) => idText(key, 'eligible nominee key'));
    for (const key of eligible) if (!keys.has(key)) throw badRequest('VALIDATION_ERROR', `Award references unknown nominee key: ${key}`);
    const uniqueEligible = [...new Set(eligible)];
    if (uniqueEligible.length < 2) throw badRequest('VALIDATION_ERROR', `awards[${index}] must contain at least two distinct eligible nominees`);
    return {
      title: text(award.title, `awards[${index}].title`, { max: 100 }),
      description: text(award.description ?? '', `awards[${index}].description`, { required: false, max: 500 }),
      eligibleNomineeKeys: uniqueEligible,
    };
  });
  return {
    eventId: input.eventId ? idText(input.eventId, 'eventId') : null,
    expectedEventVersion: optionalVersion(input.expectedEventVersion, 'expectedEventVersion'),
    title: text(input.title, 'title', { max: 100 }),
    subtitle: text(input.subtitle ?? '', 'subtitle', { required: false, max: 200 }),
    participantLimit: integer(input.participantLimit ?? 30, 'participantLimit', { min: 2, max: 250 }),
    nominees,
    awards,
  };
}

function validatePeopleList(raw) {
  const input = object(raw);
  const entriesRaw = array(input.entries, 'entries', { min: 1, max: 100 });
  const entries = entriesRaw.map((rawEntry, index) => {
    const entry = object(rawEntry, `entries[${index}]`);
    return {
      displayName: text(entry.displayName, `entries[${index}].displayName`, { max: 100 }),
      subtitle: text(entry.subtitle ?? '', `entries[${index}].subtitle`, { required: false, max: 100 }),
    };
  });
  const names = new Set();
  for (const entry of entries) {
    const identity = `${entry.displayName.toLocaleLowerCase()}:${entry.subtitle.toLocaleLowerCase()}`;
    if (names.has(identity)) throw badRequest('VALIDATION_ERROR', `Duplicate person: ${entry.displayName}`);
    names.add(identity);
  }
  return {
    listId: input.listId || input.id ? idText(input.listId ?? input.id, 'listId') : null,
    name: text(input.name, 'name', { max: 100 }),
    entries,
  };
}

function requireRound(round) {
  if (!round) throw conflict('NO_ACTIVE_ROUND', 'There is no active award round');
}

function publicEvent(event) {
  return {
    id: event.id,
    title: event.title,
    subtitle: event.subtitle,
    status: event.status,
    joinOpen: Boolean(event.join_open),
    displayBlanked: Boolean(event.display_blanked),
    version: event.version,
  };
}

function publicProgressOnly(tally) {
  return { ...tally, counts: [], contendersWithVotes: 0 };
}

function normaliseBooleans(row) {
  const result = { ...row };
  for (const key of ['joinOpen', 'active', 'displayBlanked']) if (key in result) result[key] = Boolean(result[key]);
  return result;
}

export { EVENT_STATES, ROUND_STATES };
