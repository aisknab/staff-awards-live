import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAction, createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from './helpers/test-app.js';

test('configuration requires two distinct eligible nominees', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  const result = await admin.request('/api/admin/event-config', {
    method: 'PUT',
    body: {
      title: 'Invalid event',
      participantLimit: 30,
      nominees: [
        { key: 'n1', displayName: 'Alex', subtitle: '' },
        { key: 'n2', displayName: 'Blair', subtitle: '' },
      ],
      awards: [{ title: 'Award', description: '', eligibleNomineeKeys: ['n1', 'n1'] }],
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.error.code, 'VALIDATION_ERROR');
});

test('finishing an event clears an unrevealed active round and prevents further joins', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await adminAction(admin, state, 'OPEN_LOBBY');
  state = await adminAction(admin, state, 'SHOW_AWARD');
  state = await adminAction(admin, state, 'FINISH_EVENT');
  assert.equal(state.event.status, 'FINISHED');
  assert.equal(state.event.currentRound, null);
  assert.equal(state.event.joinOpen, false);

  const participant = ctx.client();
  const join = await participant.request('/api/participant/join', {
    method: 'POST', csrf: false, body: { code: state.event.access.manualCode },
  });
  assert.equal(join.response.status, 403);

  state = await adminAction(admin, state, 'REOPEN_EVENT');
  assert.equal(state.event.status, 'LOBBY');
  assert.equal(state.event.joinOpen, true);
  assert.equal(state.event.currentRound.status, 'PREVIEW');
  assert.equal(state.event.currentRound.roundNumber, 1);
  const joined = await joinWithCode(participant, state.event.access.manualCode);
  assert.equal(joined.event.status, 'LOBBY');
  assert.equal(joined.round.status, 'PREVIEW');
});

test('restarting a finished event clears participants and prior results', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, {
    awards: [{ title: 'Only Award', description: '', eligibleNomineeKeys: ['n1', 'n2', 'n3', 'n4'] }],
  });
  state = await openFirstRound(admin, state);
  const participant = ctx.client();
  const joined = await joinWithCode(participant, state.event.access.manualCode);
  await participant.json('/api/participant/vote', {
    method: 'PUT',
    body: {
      roundId: joined.round.id,
      nomineeId: joined.round.nominees[0].id,
      requestId: crypto.randomUUID(),
      expectedRoundVersion: joined.round.version,
    },
  });
  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  state = await adminAction(admin, state, 'NEXT_AWARD');
  assert.equal(state.event.status, 'FINISHED');
  assert.equal(state.progress.registeredParticipants, 1);
  assert.equal(state.progress.completedAwards, 1);
  assert.equal(state.participants.length, 1);

  state = await adminAction(admin, state, 'RESTART_EVENT');
  assert.equal(state.event.status, 'LOBBY');
  assert.equal(state.event.joinOpen, true);
  assert.equal(state.event.currentRound, null);
  assert.equal(state.progress.registeredParticipants, 0);
  assert.equal(state.progress.completedAwards, 0);
  assert.equal(state.participants.length, 0);

  const freshParticipant = ctx.client();
  const freshJoin = await joinWithCode(freshParticipant, state.event.access.manualCode);
  assert.equal(freshJoin.participant.label, 'Guest 01');
  state = await adminAction(admin, state, 'SHOW_AWARD');
  assert.equal(state.event.currentRound.status, 'PREVIEW');
  assert.equal(state.event.currentRound.roundNumber, 1);
});

test('participant labels remain unique after a revoked participant frees capacity', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, { participantLimit: 2 });
  state = await adminAction(admin, state, 'OPEN_LOBBY');
  const first = ctx.client();
  const second = ctx.client();
  const firstState = await joinWithCode(first, state.event.access.manualCode);
  const secondState = await joinWithCode(second, state.event.access.manualCode);
  assert.equal(firstState.participant.label, 'Guest 01');
  assert.equal(secondState.participant.label, 'Guest 02');

  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await admin.json('/api/admin/revoke-participant', {
    method: 'POST',
    body: { eventId: state.event.id, participantId: secondState.participant.id },
  });
  const third = ctx.client();
  const thirdState = await joinWithCode(third, state.event.access.manualCode);
  assert.equal(thirdState.participant.label, 'Guest 03');
});
