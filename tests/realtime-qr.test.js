import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, joinWithCode, loginAdmin, openFirstRound, startTestApp } from './helpers/test-app.js';

async function firstSseEvent(baseUrl, client, path) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: client.cookieHeader(), Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
    try { await reader.cancel(); } catch {}
  }
  const blocks = text.split('\n\n').filter((block) => block.includes('event: snapshot'));
  assert.ok(blocks.length > 0, `No snapshot event in ${text}`);
  const dataLine = blocks[0].split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine.slice(6));
}

test('QR endpoints render SVG and participant/display SSE streams send snapshots', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);
  let state = await createEvent(admin);
  state = await openFirstRound(admin, state);

  const qr = await admin.request(`/api/admin/join-qr.svg?eventId=${state.event.id}`, { raw: true });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  assert.match(await qr.text(), /<svg/);

  const participant = ctx.client();
  const participantState = await joinWithCode(participant, state.event.access.manualCode);
  const participantSnapshot = await firstSseEvent(ctx.baseUrl, participant, '/api/participant/stream');
  assert.equal(participantSnapshot.role, 'PARTICIPANT');
  assert.equal(participantSnapshot.round.id, participantState.round.id);

  const displayToken = state.event.access.displayUrl.split('#display/')[1];
  const display = ctx.client();
  const displayState = await display.json('/api/display/join', { method: 'POST', csrf: false, body: { token: displayToken } });
  assert.equal(displayState.role, 'DISPLAY');
  const displayQr = await display.request('/api/display/join-qr.svg', { raw: true });
  assert.equal(displayQr.status, 200);
  assert.match(await displayQr.text(), /<svg/);
  const displaySnapshot = await firstSseEvent(ctx.baseUrl, display, '/api/display/stream');
  assert.equal(displaySnapshot.role, 'DISPLAY');
  assert.equal(displaySnapshot.round.id, participantState.round.id);
});
