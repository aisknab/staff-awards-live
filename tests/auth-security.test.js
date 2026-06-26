import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, loginAdmin, ORIGIN, startTestApp } from './helpers/test-app.js';

test('admin authentication, CSRF, Origin, and security headers are enforced', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.stop());

  const anonymous = ctx.client();
  const unauth = await anonymous.request('/api/admin/state');
  assert.equal(unauth.response.status, 401);

  const badLogin = await anonymous.request('/api/admin/login', {
    method: 'POST', csrf: false, body: { username: 'admin', password: 'wrong' },
  });
  assert.equal(badLogin.response.status, 401);

  const admin = ctx.client();
  const loggedIn = await loginAdmin(admin);
  assert.equal(loggedIn.role, 'ADMIN');
  assert.ok(admin.cookies.has('awards_admin_session'));
  assert.ok(admin.csrfToken);

  const missingCsrf = await admin.request('/api/admin/event-config', {
    method: 'PUT', csrf: false, body: { title: 'x' },
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.error.code, 'FORBIDDEN');

  const wrongOrigin = await admin.request('/api/admin/event-config', {
    method: 'PUT', origin: 'https://evil.example', body: { title: 'x' },
  });
  assert.equal(wrongOrigin.response.status, 403);

  const state = await createEvent(admin);
  assert.equal(state.event.status, 'DRAFT');

  const page = await fetch(`${ctx.baseUrl}/admin`, { headers: { Origin: ORIGIN } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const dashboardPage = await fetch(`${ctx.baseUrl}/dashboard`, { headers: { Origin: ORIGIN } });
  assert.equal(dashboardPage.status, 200);
  assert.match(dashboardPage.headers.get('content-security-policy'), /default-src 'self'/);
});
