import test from 'node:test';
import assert from 'node:assert/strict';
import { leaderStatus } from '../src/result-service.js';
import { deriveAccessToken, deriveManualCode, hashPassword, verifyAccessToken, verifyPassword } from '../src/security.js';
import { csvCell, stableHashInt } from '../src/utils.js';

const secret = '12345678901234567890123456789012';

test('leader status covers no votes, ties, and clear leaders', () => {
  assert.equal(leaderStatus([], 0), 'NO_VOTES');
  assert.equal(leaderStatus([1], 1), 'TOO_EARLY');
  assert.equal(leaderStatus([2, 2], 4), 'TIED');
  assert.equal(leaderStatus([3, 2], 5), 'VERY_CLOSE');
  assert.equal(leaderStatus([4, 2], 6), 'LEADER_EMERGING');
  assert.equal(leaderStatus([6, 2], 8), 'CLEAR_LEADER');
});

test('tokens and manual codes are deterministic and purpose separated', () => {
  const join = deriveAccessToken(secret, 'join', 'event-1', 1);
  const display = deriveAccessToken(secret, 'display', 'event-1', 1);
  const dashboard = deriveAccessToken(secret, 'dashboard', 'event-1', '2026-01-01T00:00:00.000Z');
  assert.notEqual(join, display);
  assert.notEqual(dashboard, display);
  assert.notEqual(join, deriveAccessToken(secret, 'join', 'event-1', 2));
  assert.match(deriveManualCode(secret, 'event-1', 1), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(deriveManualCode(secret, 'event-1', 1), deriveManualCode(secret, 'event-1', 1));
  assert.equal(verifyAccessToken(secret, 'dashboard', dashboard, { id: 'event-1', status: 'FINISHED', finished_at: '2026-01-01T00:00:00.000Z' }), true);
  assert.equal(verifyAccessToken(secret, 'dashboard', dashboard, { id: 'event-1', status: 'LIVE', finished_at: null }), false);
});

test('scrypt password encoding verifies safely', async () => {
  const encoded = await hashPassword('correct horse battery staple', { N: 1024 });
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('incorrect', encoded), false);
  assert.equal(await verifyPassword('anything', 'malformed'), false);
});

test('CSV cells neutralise spreadsheet formula prefixes', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('hello, world'), '"hello, world"');
  assert.equal(csvCell('safe'), 'safe');
});

test('stable hash ordering input is repeatable', () => {
  assert.equal(stableHashInt('participant:round:nominee', secret), stableHashInt('participant:round:nominee', secret));
});
