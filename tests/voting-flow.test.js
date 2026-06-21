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
  assert.equal(revealed.round.revealed.winners.length, 1);
  assert.equal(revealed.round.revealed.winners[0].count, 9);
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
