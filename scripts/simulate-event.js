import assert from 'node:assert/strict';
import { adminAction, createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from '../tests/helpers/test-app.js';

const started = Date.now();
const context = await startTestApp({ maskedMinIntervalMs: 20, maskedMaxDelayMs: 60 });
try {
  const admin = context.client();
  await loginAdmin(admin);
  let state = await createEvent(admin, { participantLimit: 25 });
  state = await openFirstRound(admin, state);
  const participants = Array.from({ length: 20 }, () => context.client());
  const joined = await Promise.all(participants.map((client) => joinWithCode(client, state.event.access.manualCode)));
  assert.equal(joined.length, 20);
  const targets = joined[0].round.nominees.map((nominee) => nominee.id);
  await Promise.all(participants.map((client, index) => client.json('/api/participant/vote', {
    method: 'PUT',
    body: {
      roundId: joined[index].round.id,
      nomineeId: targets[index < 10 ? 0 : index < 16 ? 1 : index < 19 ? 2 : 3],
      requestId: crypto.randomUUID(),
      expectedRoundVersion: joined[index].round.version,
    },
  })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const publicState = await participants[0].json('/api/participant/state');
  assert.deepEqual(publicState.round.maskedTally.counts, [10, 6, 3, 1]);
  const masked = JSON.stringify(publicState.round.maskedTally);
  for (const nominee of joined[0].round.nominees) {
    assert.equal(masked.includes(nominee.id), false);
    assert.equal(masked.includes(nominee.name), false);
  }
  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  state = await adminAction(admin, state, 'NEXT_QUESTION');
  assert.equal(state.event.currentRound.status, 'OPEN');

  const secondRoundStates = await Promise.all(participants.slice(0, 4).map((client) => client.json('/api/participant/state')));
  const tieTargets = secondRoundStates[0].round.nominees.slice(0, 2).map((nominee) => nominee.id);
  await Promise.all(participants.slice(0, 4).map((client, index) => client.json('/api/participant/vote', {
    method: 'PUT',
    body: {
      roundId: secondRoundStates[index].round.id,
      nomineeId: tieTargets[index % 2],
      requestId: crypto.randomUUID(),
      expectedRoundVersion: secondRoundStates[index].round.version,
    },
  })));
  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  state = await adminAction(admin, state, 'START_RUNOFF');
  assert.equal(state.event.currentRound.roundNumber, 2);
  state = await adminAction(admin, state, 'OPEN_VOTING');
  const runoff = await participants[0].json('/api/participant/state');
  assert.equal(runoff.round.nominees.length, 2);
  await participants[0].json('/api/participant/vote', {
    method: 'PUT',
    body: { roundId: runoff.round.id, nomineeId: runoff.round.nominees[0].id, requestId: crypto.randomUUID(), expectedRoundVersion: runoff.round.version },
  });
  state = await admin.json(`/api/admin/state?eventId=${state.event.id}`);
  state = await adminAction(admin, state, 'LOCK_VOTING');
  state = await adminAction(admin, state, 'REVEAL_WINNER');
  assert.equal(state.event.currentRound.status, 'REVEALED');
  console.log(JSON.stringify({ status: 'passed', participants: 20, maskedCounts: [10, 6, 3, 1], runoff: true, durationMs: Date.now() - started }));
} finally {
  await context.stop();
}
