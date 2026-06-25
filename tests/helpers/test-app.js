import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/app.js';
import { hashPassword } from '../../src/security.js';

const ORIGIN = 'http://awards.test';
const SECRET = 'test-secret-123456789012345678901234567890';

export class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorbSetCookie(value) {
    if (!value) return;
    const first = value.split(';')[0];
    const index = first.indexOf('=');
    if (index < 1) return;
    const name = first.slice(0, index);
    const val = first.slice(index + 1);
    if (val) this.cookies.set(name, val);
    else this.cookies.delete(name);
  }

  async request(path, { method = 'GET', body, csrf = !['GET', 'HEAD'].includes(method), origin = ORIGIN, headers = {}, raw = false } = {}) {
    const requestHeaders = { Accept: raw ? '*/*' : 'application/json', Origin: origin, ...headers };
    const cookie = this.cookieHeader();
    if (cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (csrf && this.csrfToken) requestHeaders['X-CSRF-Token'] = this.csrfToken;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.absorbSetCookie(response.headers.get('set-cookie'));
    if (raw) return response;
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (payload?.csrfToken) this.csrfToken = payload.csrfToken;
    return { response, payload };
  }

  async json(path, options = {}) {
    const { response, payload } = await this.request(path, options);
    if (!response.ok) {
      const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

export async function startTestApp(options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'staff-awards-test-'));
  const databasePath = options.databasePath ?? join(directory, 'awards.sqlite');
  const adminPasswordHash = options.adminPasswordHash ?? await hashPassword('test-password', { N: 1024 });
  const app = createApplication({
    configOverrides: {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 0,
      publicOrigin: ORIGIN,
      databasePath,
      appSecret: SECRET,
      adminUsername: 'admin',
      adminPasswordHash,
      maskedMinVotes: options.maskedMinVotes ?? 3,
      maskedMinIntervalMs: options.maskedMinIntervalMs ?? 30,
      maskedMaxDelayMs: options.maskedMaxDelayMs ?? 80,
    },
    logger: options.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
  });
  await app.start();
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    directory,
    databasePath,
    baseUrl,
    client: () => new TestClient(baseUrl),
    async stop({ remove = !options.directory } = {}) {
      await app.stop();
      if (remove) rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function loginAdmin(client) {
  return client.json('/api/admin/login', {
    method: 'POST',
    csrf: false,
    body: { username: 'admin', password: 'test-password' },
  });
}

export async function createEvent(admin, options = {}) {
  const nominees = options.nominees ?? [
    { key: 'n1', displayName: 'Alex Smith', subtitle: 'Sales' },
    { key: 'n2', displayName: 'Blair Chen', subtitle: 'Engineering' },
    { key: 'n3', displayName: 'Casey Jones', subtitle: 'Operations' },
    { key: 'n4', displayName: 'Dev Singh', subtitle: 'Marketing' },
  ];
  const awards = options.awards ?? [
    { title: 'Mr Mute', description: 'Always talking on mute', eligibleNomineeKeys: nominees.map((nominee) => nominee.key) },
    { title: 'Reply All Hero', description: 'For broad email distribution', eligibleNomineeKeys: nominees.map((nominee) => nominee.key) },
  ];
  return admin.json('/api/admin/event-config', {
    method: 'PUT',
    body: {
      title: options.title ?? 'Test Awards',
      subtitle: options.subtitle ?? 'Annual staff event',
      participantLimit: options.participantLimit ?? 30,
      voteDurationSeconds: options.voteDurationSeconds ?? 45,
      nominees,
      awards,
    },
  });
}

export async function adminAction(admin, state, action) {
  return admin.json('/api/admin/action', {
    method: 'POST',
    body: {
      eventId: state.event.id,
      action,
      expectedEventVersion: state.event.version,
      expectedRoundVersion: state.event.currentRound?.version ?? null,
    },
  });
}

export async function openFirstRound(admin, state) {
  let next = await adminAction(admin, state, 'OPEN_LOBBY');
  next = await adminAction(admin, next, 'SHOW_AWARD');
  next = await adminAction(admin, next, 'OPEN_VOTING');
  return next;
}

export async function joinWithCode(client, code) {
  return client.json('/api/participant/join', { method: 'POST', csrf: false, body: { code } });
}

export { ORIGIN, SECRET };
