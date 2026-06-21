import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminAction, createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from './helpers/test-app.js';

test('tied results can start a runoff with only tied nominees', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);
  const clients = [ctx.client(), ctx.client(), ctx.client(), ctx.client()];
  const joined = await Promise.all(clients.map((client) => joinWithCode(client, state.event.access.manualCode)));
  const firstTwo = joined[0].round.nominees.slice(0, 2);
  await Promise.all(clients.map((client, index) => client.json('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: joined[index].round.id, nomineeId: firstTwo[index % 2].id, requestId: crypto.randomUUID(), expectedRoundVersion: joined[index].round.version },
  })));
  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  assert.equal(state.event.currentRound.resultDecision.mode, 'tie');
  assert.deepEqual(new Set(state.event.currentRound.resultDecision.tiedNominees.map((nominee) => nominee.nomineeId)), new Set(firstTwo.map((nominee) => nominee.id)));
  const normalReveal = await admin.request('/api/admin/action', {
    method: 'POST',
    body: { eventId: state.event.id, action: 'REVEAL_WINNER', expectedEventVersion: state.event.version, expectedRoundVersion: state.event.currentRound.version },
  });
  assert.equal(normalReveal.response.status, 409);
  assert.equal(normalReveal.payload.error.code, 'TIE_REQUIRES_DECISION');
  state = await adminAction(admin, state, 'START_RUNOFF');
  assert.equal(state.event.currentRound.roundNumber, 2);
  assert.equal(state.event.currentRound.status, 'PREVIEW');
  state = await adminAction(admin, state, 'OPEN_VOTING');
  const runoffParticipant = await clients[0].json('/api/participant/state');
  assert.equal(runoffParticipant.round.nominees.length, 2);
  assert.deepEqual(new Set(runoffParticipant.round.nominees.map((nominee) => nominee.id)), new Set(firstTwo.map((nominee) => nominee.id)));
});

test('event and votes survive an application restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'staff-awards-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await startTestApp({ directory });
  const admin = first.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);
  const eventId = state.event.id;
  const participant = first.client();
  let participantState = await joinWithCode(participant, state.event.access.manualCode);
  await participant.json('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: participantState.round.id, nomineeId: participantState.round.nominees[0].id, requestId: crypto.randomUUID(), expectedRoundVersion: participantState.round.version },
  });
  const adminCookie = new Map(admin.cookies);
  const participantCookie = new Map(participant.cookies);
  const adminCsrf = admin.csrfToken;
  const participantCsrf = participant.csrfToken;
  const passwordHash = first.app.config.adminPasswordHash;
  await first.stop({ remove: false });

  const second = await startTestApp({ directory, adminPasswordHash: passwordHash });
  t.after(() => second.stop({ remove: false }));
  const restoredAdmin = second.client();
  restoredAdmin.cookies = adminCookie;
  restoredAdmin.csrfToken = adminCsrf;
  const restoredParticipant = second.client();
  restoredParticipant.cookies = participantCookie;
  restoredParticipant.csrfToken = participantCsrf;

  const adminState = await restoredAdmin.json(`/api/admin/state?eventId=${eventId}`);
  assert.equal(adminState.event.currentRound.status, 'OPEN');
  assert.equal(adminState.namedTally.votesCast, 1);
  participantState = await restoredParticipant.json('/api/participant/state');
  assert.ok(participantState.round.ownVote);
});
