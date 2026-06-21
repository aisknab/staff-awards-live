import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAction, createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from './helpers/test-app.js';

test('two-way tie defaults to joint winner choice and reveals both winners', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  const display = ctx.client();
  await joinDisplay(display, state);
  const clients = [ctx.client(), ctx.client(), ctx.client(), ctx.client()];
  const joined = await Promise.all(clients.map((client) => joinWithCode(client, state.event.access.manualCode)));
  const tied = joined[0].round.nominees.slice(0, 2);
  await voteRound(clients, joined, [tied[0].id, tied[1].id, tied[0].id, tied[1].id]);

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  const roundId = state.event.currentRound.id;
  assert.equal(state.event.currentRound.resultDecision.mode, 'tie');
  assert.equal(state.event.currentRound.resultDecision.topCount, 2);
  assert.deepEqual(new Set(state.event.currentRound.resultDecision.tiedNominees.map((nominee) => nominee.nomineeId)), new Set(tied.map((nominee) => nominee.id)));

  const normalReveal = await admin.request('/api/admin/action', {
    method: 'POST',
    body: { eventId: state.event.id, action: 'REVEAL_WINNER', expectedEventVersion: state.event.version, expectedRoundVersion: state.event.currentRound.version },
  });
  assert.equal(normalReveal.response.status, 409);
  assert.equal(normalReveal.payload.error.code, 'TIE_REQUIRES_DECISION');

  const participantLocked = await clients[0].json('/api/participant/state');
  const displayLocked = await display.json('/api/display/state');
  assertMaskedTallyContainsNoIdentity(participantLocked.round.maskedTally, joined[0].round.nominees);
  assertMaskedTallyContainsNoIdentity(displayLocked.round.maskedTally, joined[0].round.nominees);
  assert.equal(JSON.stringify(participantLocked).includes('namedTally'), false);
  assert.equal(JSON.stringify(displayLocked).includes('namedTally'), false);

  state = await adminAction(admin, state, 'REVEAL_JOINT_WINNERS');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  assertPersistedWinners(ctx, roundId, tied.map((nominee) => nominee.id));

  const participantReveal = await clients[0].json('/api/participant/state');
  const displayReveal = await display.json('/api/display/state');
  for (const publicState of [participantReveal, displayReveal]) {
    assert.equal(publicState.round.revealed.winnerMode, 'joint');
    assert.deepEqual(new Set(publicState.round.revealed.winners.map((winner) => winner.nomineeId)), new Set(tied.map((nominee) => nominee.id)));
    assert.deepEqual(publicState.round.revealed.winners.map((winner) => winner.voteCount), [2, 2]);
    assert.deepEqual(publicState.round.revealed.winners.map((winner) => winner.percentage), [50, 50]);
  }

  const csv = await exportCsv(admin, state.event.id);
  const jointWinnerRows = csv.split(/\r?\n/).filter((line) => line.includes('Joint winner'));
  assert.equal(jointWinnerRows.length, 2);
  for (const nominee of tied) assert.ok(jointWinnerRows.some((line) => line.includes(nominee.name)), `${nominee.name} missing from export`);
});

test('three-way tie persists every joint winner', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  const clients = Array.from({ length: 6 }, () => ctx.client());
  const joined = await Promise.all(clients.map((client) => joinWithCode(client, state.event.access.manualCode)));
  const tied = joined[0].round.nominees.slice(0, 3);
  await voteRound(clients, joined, [tied[0].id, tied[1].id, tied[2].id, tied[0].id, tied[1].id, tied[2].id]);

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  assert.equal(state.event.currentRound.resultDecision.mode, 'tie');
  assert.equal(state.event.currentRound.resultDecision.tiedNominees.length, 3);
  const roundId = state.event.currentRound.id;
  state = await adminAction(admin, state, 'REVEAL_JOINT_WINNERS');

  assertPersistedWinners(ctx, roundId, tied.map((nominee) => nominee.id));
  const revealed = await clients[0].json('/api/participant/state');
  assert.equal(revealed.round.revealed.winnerMode, 'joint');
  assert.deepEqual(new Set(revealed.round.revealed.winners.map((winner) => winner.nomineeId)), new Set(tied.map((nominee) => nominee.id)));
});

test('revealing an open tied round defaults to joint winners', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  const clients = [ctx.client(), ctx.client()];
  const joined = await Promise.all(clients.map((client) => joinWithCode(client, state.event.access.manualCode)));
  const tied = joined[0].round.nominees.slice(0, 2);
  await voteRound(clients, joined, [tied[0].id, tied[1].id]);

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  const revealed = await clients[0].json('/api/participant/state');
  assert.equal(revealed.round.revealed.winnerMode, 'joint');
  assert.deepEqual(new Set(revealed.round.revealed.winners.map((winner) => winner.nomineeId)), new Set(tied.map((nominee) => nominee.id)));
});

test('no-vote round reveals no winner', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  state = await adminAction(admin, state, 'LOCK_VOTING');
  const roundId = state.event.currentRound.id;
  assert.equal(state.event.currentRound.resultDecision.mode, 'none');
  assert.equal(state.event.currentRound.resultDecision.message, 'No votes were cast for this award');

  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  const revealed = ctx.app.services.resultService.revealed(roundId);
  assert.equal(revealed.winnerMode, 'none');
  assert.equal(revealed.winners.length, 0);
  assert.equal(revealed.results.every((row) => !row.isWinner), true);
});

async function voteRound(clients, states, nomineeIds) {
  await Promise.all(clients.map((client, index) => client.json('/api/participant/vote', {
    method: 'PUT',
    body: {
      roundId: states[index].round.id,
      nomineeId: nomineeIds[index],
      requestId: crypto.randomUUID(),
      expectedRoundVersion: states[index].round.version,
    },
  })));
}

async function joinDisplay(client, state) {
  const token = new URL(state.event.access.displayUrl).hash.slice('#display/'.length);
  return client.json('/api/display/join', { method: 'POST', csrf: false, body: { token } });
}

function assertMaskedTallyContainsNoIdentity(maskedTally, nominees) {
  const serialized = JSON.stringify(maskedTally);
  for (const nominee of nominees) {
    assert.equal(serialized.includes(nominee.id), false, `masked tally leaked nominee id ${nominee.id}`);
    assert.equal(serialized.includes(nominee.name), false, `masked tally leaked nominee name ${nominee.name}`);
    assert.equal(serialized.includes(nominee.subtitle), false, `masked tally leaked nominee subtitle ${nominee.subtitle}`);
  }
  for (const key of ['nomineeId', 'name', 'subtitle', 'displayName', 'results', 'winners']) {
    assert.equal(serialized.includes(key), false, `masked tally leaked key ${key}`);
  }
}

function assertPersistedWinners(ctx, roundId, expectedWinnerIds) {
  const rows = ctx.app.services.database.prepare(`
    SELECT nominee_id AS nomineeId, is_winner AS isWinner
    FROM revealed_results
    WHERE round_id = ?
  `).all(roundId);
  const actualWinnerIds = rows.filter((row) => row.isWinner).map((row) => row.nomineeId);
  assert.deepEqual(new Set(actualWinnerIds), new Set(expectedWinnerIds));
}

async function exportCsv(admin, eventId) {
  const { response, payload } = await admin.request(`/api/admin/export.csv?eventId=${encodeURIComponent(eventId)}`);
  assert.equal(response.status, 200);
  return payload;
}
