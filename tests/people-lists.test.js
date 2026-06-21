import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, loginAdmin, startTestApp } from './helpers/test-app.js';

function nomineesFromEntries(entries) {
  return entries.map((entry, index) => ({ key: `n${index + 1}`, displayName: entry.displayName, subtitle: entry.subtitle }));
}

test('saved people lists can be reused without mutating existing event options', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  let state = await loginAdmin(admin);
  assert.deepEqual(state.peopleLists, []);

  state = await admin.json('/api/admin/people-lists', {
    method: 'PUT',
    body: {
      name: 'All staff',
      entries: [
        { displayName: 'Alex Smith', subtitle: 'Sales' },
        { displayName: 'Blair Chen', subtitle: 'Engineering' },
      ],
    },
  });
  assert.equal(state.peopleLists.length, 1);
  const list = state.peopleLists[0];
  assert.equal(list.name, 'All staff');
  assert.deepEqual(list.entries.map((entry) => entry.displayName), ['Alex Smith', 'Blair Chen']);

  state = await createEvent(admin, {
    nominees: nomineesFromEntries(list.entries),
    awards: [{ title: 'Team Player', description: '', eligibleNomineeKeys: ['n1', 'n2'] }],
  });
  assert.deepEqual(state.event.nominees.map((nominee) => nominee.displayName), ['Alex Smith', 'Blair Chen']);

  state = await admin.json('/api/admin/people-lists', {
    method: 'PUT',
    body: {
      listId: list.id,
      name: 'Core staff',
      entries: [
        { displayName: 'Alex Smith', subtitle: 'Sales' },
        { displayName: 'Casey Jones', subtitle: 'Operations' },
      ],
    },
  });
  assert.equal(state.peopleLists.length, 1);
  assert.equal(state.peopleLists[0].id, list.id);
  assert.equal(state.peopleLists[0].name, 'Core staff');
  assert.deepEqual(state.peopleLists[0].entries.map((entry) => entry.displayName), ['Alex Smith', 'Casey Jones']);
  assert.deepEqual(state.event.nominees.map((nominee) => nominee.displayName), ['Alex Smith', 'Blair Chen']);

  state = await admin.json('/api/admin/people-lists', {
    method: 'DELETE',
    body: { listId: list.id },
  });
  assert.deepEqual(state.peopleLists, []);
  assert.deepEqual(state.event.nominees.map((nominee) => nominee.displayName), ['Alex Smith', 'Blair Chen']);
});

test('saved people list names and entries are validated', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());
  const admin = ctx.client();
  await loginAdmin(admin);

  await admin.json('/api/admin/people-lists', {
    method: 'PUT',
    body: {
      name: 'All staff',
      entries: [{ displayName: 'Alex Smith', subtitle: '' }],
    },
  });
  const duplicateName = await admin.request('/api/admin/people-lists', {
    method: 'PUT',
    body: {
      name: 'all STAFF',
      entries: [{ displayName: 'Blair Chen', subtitle: '' }],
    },
  });
  assert.equal(duplicateName.response.status, 409);
  assert.equal(duplicateName.payload.error.code, 'PEOPLE_LIST_EXISTS');

  const duplicateEntry = await admin.request('/api/admin/people-lists', {
    method: 'PUT',
    body: {
      name: 'Duplicates',
      entries: [
        { displayName: 'Alex Smith', subtitle: '' },
        { displayName: 'alex smith', subtitle: '' },
      ],
    },
  });
  assert.equal(duplicateEntry.response.status, 400);
  assert.equal(duplicateEntry.payload.error.code, 'VALIDATION_ERROR');
});
