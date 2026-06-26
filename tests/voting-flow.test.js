import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAction, createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from './helpers/test-app.js';

function assertMaskedBoundary(state, nomineeNames, nomineeIds) {
  const serialized = JSON.stringify(state.round.maskedTally);
  for (const name of nomineeNames) assert.equal(serialized.includes(name), false, `masked tally leaked nominee name ${name}`);
  for (const id of nomineeIds) assert.equal(serialized.includes(id), false, `masked tally leaked nominee id ${id}`);
  assert.deepEqual(Object.keys(state.round.maskedTally).sort(), [
    'contendersWithVotes', 'counts', 'eligibleParticipants', 'hiddenUntilVotes', 'leaderStatus', 'roundId', 'roundVersion', 'serverTime', 'votesCast',
  ].sort());
}

test('20 participants vote concurrently while public tallies remain unmapped', async (t) => {
  const ctx = await startTestApp({ maskedMinIntervalMs: 20, maskedMaxDelayMs: 50 });
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, { participantLimit: 25 });
  state = await openFirstRound(admin, state);

  const code = state.event.access.manualCode;
  const participants = Array.from({ length: 20 }, () => ctx.client());
  const participantStates = await Promise.all(participants.map((client) => joinWithCode(client, code)));
  assert.equal(new Set(participantStates.map((item) => item.participant.id)).size, 20);

  const nomineeNames = participantStates[0].round.nominees.map((nominee) => nominee.name);
  const nomineeIds = participantStates[0].round.nominees.map((nominee) => nominee.id);
  assertMaskedBoundary(participantStates[0], nomineeNames, nomineeIds);

  const targets = participantStates[0].round.nominees.map((nominee) => nominee.id);
  const votes = participants.map((client, index) => {
    const current = participantStates[index];
    const targetId = index < 9 ? targets[0] : index < 15 ? targets[1] : index < 19 ? targets[2] : targets[3];
    const nominee = current.round.nominees.find((candidate) => candidate.id === targetId);
    return client.json('/api/participant/vote', {
      method: 'PUT',
      body: { roundId: current.round.id, nomineeId: nominee.id, requestId: crypto.randomUUID(), expectedRoundVersion: current.round.version },
    });
  });
  const votedStates = await Promise.all(votes);
  assert.equal(votedStates.every((item) => item.round.ownVote), true);
  assertMaskedBoundary(votedStates[0], nomineeNames, nomineeIds);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const publicState = await participants[0].json('/api/participant/state');
  assert.deepEqual(publicState.round.maskedTally.counts, [9, 6, 4, 1]);
  assertMaskedBoundary(publicState, nomineeNames, nomineeIds);

  const adminState = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  assert.equal(adminState.namedTally.votesCast, 20);
  assert.deepEqual(adminState.namedTally.results.map((row) => row.count), [9, 6, 4, 1]);

  state = await adminAction(admin, adminState, 'LOCK_VOTING');
  const lateVote = await participants[0].request('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: publicState.round.id, nomineeId: nomineeIds[1], requestId: crypto.randomUUID(), expectedRoundVersion: publicState.round.version },
  });
  assert.equal(lateVote.response.status, 409);
  assert.equal(lateVote.payload.error.code, 'ROUND_LOCKED');

  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  const revealed = await participants[0].json('/api/participant/state');
  assert.equal(revealed.round.revealed.winnerMode, 'single');
  assert.equal(revealed.round.revealed.winners.length, 1);
  assert.equal(revealed.round.revealed.winners[0].count, 9);
  assert.equal(revealed.round.revealed.winners[0].voteCount, 9);
});

test('round timer rejects votes after the configured deadline', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, { voteDurationSeconds: 1 });
  assert.equal(state.event.voteDurationSeconds, 1);
  state = await openFirstRound(admin, state);
  assert.equal(Boolean(state.event.currentRound.voteClosesAt), true);

  const participant = ctx.client();
  const joined = await joinWithCode(participant, state.event.access.manualCode);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const lateVote = await participant.request('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: joined.round.id, nomineeId: joined.round.nominees[0].id, requestId: crypto.randomUUID(), expectedRoundVersion: joined.round.version },
  });
  assert.equal(lateVote.response.status, 409);
  assert.equal(lateVote.payload.error.code, 'ROUND_LOCKED');
});

test('a participant can change one persisted vote before lock', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);
  const participant = ctx.client();
  let current = await joinWithCode(participant, state.event.access.manualCode);
  const first = current.round.nominees[0];
  const second = current.round.nominees[1];
  current = await participant.json('/api/participant/vote', { method: 'PUT', body: { roundId: current.round.id, nomineeId: first.id, requestId: crypto.randomUUID(), expectedRoundVersion: current.round.version } });
  current = await participant.json('/api/participant/vote', { method: 'PUT', body: { roundId: current.round.id, nomineeId: second.id, requestId: crypto.randomUUID(), expectedRoundVersion: current.round.version } });
  assert.equal(current.round.ownVote.nomineeId, second.id);
  const adminState = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  assert.equal(adminState.namedTally.votesCast, 1);
  assert.equal(adminState.namedTally.results.find((row) => row.nomineeId === second.id).count, 1);
  assert.equal(adminState.namedTally.results.find((row) => row.nomineeId === first.id).count, 0);
});

test('admin can reveal an open round and advance to an already-open next question', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  const participant = ctx.client();
  const joined = await joinWithCode(participant, state.event.access.manualCode);
  await participant.json('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: joined.round.id, nomineeId: joined.round.nominees[0].id, requestId: crypto.randomUUID(), expectedRoundVersion: joined.round.version },
  });

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  assert.equal(state.event.currentRound.lockedAt !== null, true);
  let publicState = await participant.json('/api/participant/state');
  assert.equal(publicState.round.revealed.winnerMode, 'single');

  state = await adminAction(admin, state, 'NEXT_QUESTION');
  assert.equal(state.event.currentRound.status, 'OPEN');
  assert.equal(state.event.currentRound.award.title, 'Reply All Hero');
  publicState = await participant.json('/api/participant/state');
  assert.equal(publicState.round.status, 'OPEN');
  assert.equal(publicState.round.award.title, 'Reply All Hero');

});

test('final next award reveals quickest to judge special award', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, {
    awards: [
      { title: 'Mr Mute', description: 'Always talking on mute', eligibleNomineeKeys: ['n1', 'n2', 'n3', 'n4'] },
      { title: 'Reply All Hero', description: 'For broad email distribution', eligibleNomineeKeys: ['n1', 'n2', 'n3'] },
    ],
  });
  state = await openFirstRound(admin, state);

  const participants = [ctx.client(), ctx.client(), ctx.client()];
  const observer = ctx.client();
  const joined = await Promise.all([...participants, observer].map((participant) => joinWithCode(participant, state.event.access.manualCode)));

  await voteForFirstNominee(participants, joined);
  setVoteLatencies(ctx.app.services.database, state.event.currentRound.id, [
    [joined[0].participant.id, 1000],
    [joined[1].participant.id, 500],
    [joined[2].participant.id, 2000],
  ]);

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  state = await adminAction(admin, state, 'NEXT_QUESTION');
  assert.equal(state.event.currentRound.status, 'OPEN');

  const secondRoundStates = await Promise.all(participants.map((participant) => participant.json('/api/participant/state')));
  await voteForFirstNominee(participants, secondRoundStates);
  setVoteLatencies(ctx.app.services.database, state.event.currentRound.id, [
    [joined[0].participant.id, 1000],
    [joined[1].participant.id, 700],
    [joined[2].participant.id, 800],
  ]);

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  state = await adminAction(admin, state, 'NEXT_AWARD');

  assert.equal(state.event.status, 'FINISHED');
  assert.match(state.event.access.dashboardUrl, /^http:\/\/awards\.test\/dashboard#dashboard\//);
  assert.equal(state.finalDashboard.summary.awardCount, 2);
  assert.equal(state.finalDashboard.summary.completedAwards, 2);
  assert.equal(state.finalDashboard.summary.totalVotesCast, 6);
  assert.equal(state.finalDashboard.summary.averageVotesPerAward, 3);
  assert.equal(state.finalDashboard.summary.averageParticipationRate, 75);
  assert.deepEqual(state.finalDashboard.awards.map((award) => award.votesCast), [3, 3]);
  assert.deepEqual(state.finalDashboard.awards[0].excludedNominees, []);
  assert.deepEqual(state.finalDashboard.awards[1].excludedNominees.map((nominee) => nominee.name), ['Dev Singh']);
  assert.equal(state.finalDashboard.quickestJudgeAward.winnerLabel, joined[1].participant.label);
  assert.equal(state.finalDashboard.quickestJudgeAward.averageMs, 600);
  const quickestRows = state.finalDashboard.quickestJudgeAward.leaderboard.map((row) => [row.rank, row.label, row.averageMs, row.votesCast]);
  assert.deepEqual(quickestRows, [
    [1, joined[1].participant.label, 600, 2],
    [2, joined[0].participant.label, 1000, 2],
    [3, joined[2].participant.label, 1400, 2],
    [4, joined[3].participant.label, null, 0],
  ]);
  assert.equal(state.finalDashboard.awards.every((award) => award.winners.length === 1), true);
  assert.equal(state.finalDashboard.nomineeLeaderboard.reduce((sum, nominee) => sum + nominee.wins, 0), 2);
  assert.equal(state.finalDashboard.highlights.highestTurnout.participationRate, 75);

  const dashboardToken = new URL(state.event.access.dashboardUrl).hash.slice('#dashboard/'.length);
  const anonymous = ctx.client();
  const publicDashboard = await anonymous.json('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: dashboardToken } });
  assert.equal(publicDashboard.role, 'DASHBOARD');
  assert.equal(publicDashboard.event.title, state.event.title);
  assert.equal(publicDashboard.dashboard.summary.completedAwards, 2);
  assert.equal(publicDashboard.dashboard.summary.totalVotesCast, 6);
  assert.equal(publicDashboard.dashboard.awards[0].results.some((row) => row.count === 0), false);
  assert.deepEqual(publicDashboard.dashboard.awards[1].excludedNominees.map((nominee) => nominee.name), ['Dev Singh']);
  assert.equal(publicDashboard.dashboard.quickestJudgeAward.winnerLabel, joined[1].participant.label);
  assert.deepEqual(publicDashboard.dashboard.quickestJudgeAward.leaderboard.map((row) => [row.rank, row.label, row.averageMs, row.votesCast]), quickestRows);
  assert.equal('participantId' in publicDashboard.dashboard.quickestJudgeAward.leaderboard[0], false);

  const badDashboard = await anonymous.request('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: `${dashboardToken}x` } });
  assert.equal(badDashboard.response.status, 403);

  state = await admin.json('/api/admin/dashboard-password', { method: 'PUT', body: { eventId: state.event.id, expectedEventVersion: state.event.version, password: 'shareit' } });
  assert.equal(state.event.publicDashboardPasswordSet, true);

  const lockedDashboard = await anonymous.request('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: dashboardToken } });
  assert.equal(lockedDashboard.response.status, 401);
  const wrongPasswordDashboard = await anonymous.request('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: dashboardToken, password: 'wrong' } });
  assert.equal(wrongPasswordDashboard.response.status, 403);
  const unlockedDashboard = await anonymous.json('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: dashboardToken, password: 'shareit' } });
  assert.equal(unlockedDashboard.dashboard.summary.totalVotesCast, 6);

  state = await admin.json('/api/admin/dashboard-password', { method: 'PUT', body: { eventId: state.event.id, expectedEventVersion: state.event.version, password: '' } });
  assert.equal(state.event.publicDashboardPasswordSet, false);
  const clearedDashboard = await anonymous.json('/api/dashboard/state', { method: 'POST', csrf: false, body: { token: dashboardToken } });
  assert.equal(clearedDashboard.dashboard.summary.totalVotesCast, 6);
  assert.equal(state.specialAward.type, 'quickest-judge');
  assert.equal(state.specialAward.winnerLabel, joined[1].participant.label);
  assert.equal(state.specialAward.averageMs, 600);

  const winnerState = await participants[1].json('/api/participant/state');
  assert.equal(winnerState.specialAward.winnerLabel, joined[1].participant.label);
  assert.equal(winnerState.specialAward.isWinner, true);
  assert.equal(winnerState.specialAward.averageSeconds, 0.6);

  const otherState = await participants[0].json('/api/participant/state');
  assert.equal(otherState.specialAward.isWinner, false);
  assert.equal(otherState.specialAward.winnerLabel, joined[1].participant.label);

  state = await adminAction(admin, state, 'SHOW_CLOSING_AWARD');
  assert.equal(state.specialAward.type, 'closing-message');
  assert.equal(state.specialAward.title, '"Criteo Australia"');
  assert.equal(state.specialAward.kicker, 'Final award');
  assert.equal(state.specialAward.message, 'for smashing it in APAC for H1. Have fun this evening, not too hard (Nicola is here)');
  assert.equal(state.specialAward.isWinner, false);

  const closingState = await participants[0].json('/api/participant/state');
  assert.equal(closingState.specialAward.type, 'closing-message');
  assert.equal(closingState.specialAward.title, '"Criteo Australia"');
  assert.equal(closingState.specialAward.message, 'for smashing it in APAC for H1. Have fun this evening, not too hard (Nicola is here)');
});

async function voteForFirstNominee(participants, states) {
  const nomineeId = states[0].round.nominees[0].id;
  await Promise.all(participants.map((participant, index) => participant.json('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: states[index].round.id, nomineeId, requestId: crypto.randomUUID(), expectedRoundVersion: states[index].round.version },
  })));
}

function setVoteLatencies(database, roundId, participantLatencies) {
  const openedAt = '2026-01-01T00:00:00.000Z';
  database.prepare('UPDATE rounds SET opened_at = ? WHERE id = ?').run(openedAt, roundId);
  const update = database.prepare('UPDATE votes SET created_at = ?, updated_at = ? WHERE round_id = ? AND participant_id = ?');
  for (const [participantId, latencyMs] of participantLatencies) {
    const votedAt = new Date(Date.parse(openedAt) + latencyMs).toISOString();
    update.run(votedAt, votedAt, roundId, participantId);
  }
}
