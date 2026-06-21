import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Database } from './database.js';
import { EventService } from './event-service.js';
import { ResultService } from './result-service.js';
import { MaskedTallyService } from './masked-tally-service.js';
import { SessionService } from './sessions.js';
import { JoinService } from './join-service.js';
import { VotingService } from './voting-service.js';
import { SSEHub } from './sse.js';
import { RateLimiter } from './rate-limit.js';
import { createLogger } from './logging.js';
import { createQrSvg } from './qr.js';
import { serveStatic } from './static-files.js';
import { getClientIp, handleError, readJson, requestId, sendJson, sendText } from './http.js';
import { requireAdminConfigured, validateCsrf, validateOrigin, verifyPassword } from './security.js';
import { idText, object, text } from './validation.js';
import { notFound } from './errors.js';

export function createApplication(options = {}) {
  const config = options.config ?? loadConfig(options.configOverrides);
  const logger = options.logger ?? createLogger(config.logLevel);
  const database = options.database ?? new Database(config.databasePath, { migrationsDir: config.migrationsDir });
  const resultService = new ResultService(database, config);
  let hub;
  const masked = new MaskedTallyService(resultService, config, (eventId) => {
    hub?.broadcastSnapshot(eventId, ['PARTICIPANT', 'DISPLAY']);
  });
  const eventService = new EventService(database, config, resultService, masked);
  const sessionService = new SessionService(database, config);
  const joinService = new JoinService(database, config, sessionService, eventService);
  const votingService = new VotingService(database);
  const limiter = new RateLimiter();
  hub = new SSEHub(sessionService, logger);

  const buildParticipantState = (session) => {
    const state = eventService.participantState(session);
    return {
      ...state,
      csrfToken: session.csrfToken,
      progress: { ...state.progress, ...hub.presence(session.event_id) },
    };
  };

  const buildDisplayState = (session) => {
    const state = eventService.displayState(session);
    return {
      ...state,
      csrfToken: session.csrfToken,
      progress: { ...state.progress, ...hub.presence(session.event_id) },
    };
  };

  const buildAdminState = (session, requestedEventId = null) => {
    const eventList = eventService.listEvents();
    const peopleLists = eventService.listPeopleLists();
    const selectedEventId = requestedEventId
      ?? eventList.find((event) => ['LIVE', 'LOBBY'].includes(event.status))?.id
      ?? eventList.find((event) => event.status === 'DRAFT')?.id
      ?? eventList[0]?.id
      ?? null;
    if (!selectedEventId) return { role: 'ADMIN', csrfToken: session.csrfToken, events: eventList, peopleLists, selectedEventId: null, event: null };
    const state = eventService.adminState(selectedEventId);
    return {
      role: 'ADMIN',
      csrfToken: session.csrfToken,
      events: eventList,
      peopleLists,
      selectedEventId,
      ...state,
      progress: { ...state.progress, ...hub.presence(selectedEventId) },
    };
  };

  hub.onPresenceChange = (eventId) => {
    if (!eventId) return;
    let progress;
    try { progress = { ...eventService.progress(eventId), ...hub.presence(eventId) }; } catch { return; }
    hub.broadcast(eventId, ['ADMIN', 'PARTICIPANT', 'DISPLAY'], 'presence', { progress });
  };

  const server = createServer(async (req, res) => {
    const reqId = requestId(req);
    res.setHeader('X-Request-Id', reqId);
    try {
      const url = new URL(req.url ?? '/', config.publicOrigin);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && pathname === '/readyz') {
        database.prepare('SELECT 1 AS ok').get();
        const pending = database.prepare(`
          SELECT COUNT(*) AS count FROM schema_migrations
        `).get();
        return sendJson(res, 200, { status: 'ready', database: Number(pending.count) >= 1 ? 'ok' : 'unmigrated' });
      }

      if (pathname.startsWith('/api/')) {
        const handled = await handleApi({ req, res, url, pathname, reqId });
        if (handled) return;
        throw notFound('API endpoint not found');
      }

      if (await serveStatic(req, res, config.publicDir, pathname)) return;
      sendText(res, 404, 'Not found');
    } catch (error) {
      handleError(error, req, res, logger, reqId);
    }
  });

  async function handleApi({ req, res, url, pathname }) {
    const method = req.method;
    const ip = getClientIp(req, config);

    if (method === 'POST' && pathname === '/api/admin/login') {
      validateOrigin(req, config);
      limiter.check('admin-login', ip, 5, 15 * 60_000);
      requireAdminConfigured(config);
      const body = object(await readJson(req, config.maxBodyBytes));
      const username = text(body.username, 'username', { max: 100 });
      const password = String(body.password ?? '');
      const valid = username === config.adminUsername && await verifyPassword(password, config.adminPasswordHash);
      if (!valid) {
        logger.warn('Admin login failed', { source: ip });
        return sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
      }
      limiter.reset('admin-login', ip);
      const created = sessionService.create('ADMIN');
      const session = { ...created.session, csrfToken: created.csrfToken };
      logger.info('Admin login succeeded');
      return sendJson(res, 200, buildAdminState(session), { 'Set-Cookie': created.cookie });
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      sessionService.revoke(session.id);
      hub.closeWhere((connection) => connection.session.id === session.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionService.clearCookie('ADMIN') });
    }

    if (method === 'GET' && pathname === '/api/admin/state') {
      const session = sessionService.authenticate(req, 'ADMIN');
      const eventId = url.searchParams.get('eventId');
      return sendJson(res, 200, buildAdminState(session, eventId));
    }

    if (method === 'GET' && pathname === '/api/admin/stream') {
      const session = sessionService.authenticate(req, 'ADMIN');
      const eventId = idText(url.searchParams.get('eventId'), 'eventId');
      eventService.getEvent(eventId);
      hub.connect({ req, res, session, role: 'ADMIN', eventId, snapshot: () => buildAdminState(session, eventId) });
      return true;
    }

    if (method === 'PUT' && pathname === '/api/admin/event-config') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      limiter.check('admin-action', session.id, 60, 60_000);
      const body = await readJson(req, config.maxBodyBytes);
      const saved = eventService.saveConfig(body);
      logger.info('Event configuration saved', { eventId: saved.id });
      return sendJson(res, 200, buildAdminState(session, saved.id));
    }

    if (method === 'GET' && pathname === '/api/admin/people-lists') {
      sessionService.authenticate(req, 'ADMIN');
      return sendJson(res, 200, { peopleLists: eventService.listPeopleLists() });
    }

    if (method === 'PUT' && pathname === '/api/admin/people-lists') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      limiter.check('admin-action', session.id, 60, 60_000);
      const body = object(await readJson(req, config.maxBodyBytes));
      eventService.savePeopleList(body);
      const eventId = body.eventId ? idText(body.eventId, 'eventId') : null;
      return sendJson(res, 200, buildAdminState(session, eventId));
    }

    if (method === 'DELETE' && pathname === '/api/admin/people-lists') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      limiter.check('admin-action', session.id, 60, 60_000);
      const body = object(await readJson(req, config.maxBodyBytes));
      eventService.deletePeopleList(body);
      const eventId = body.eventId ? idText(body.eventId, 'eventId') : null;
      return sendJson(res, 200, buildAdminState(session, eventId));
    }

    if (method === 'POST' && pathname === '/api/admin/action') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      limiter.check('admin-action', session.id, 60, 60_000);
      const body = object(await readJson(req, config.maxBodyBytes));
      const eventId = idText(body.eventId, 'eventId');
      const action = text(body.action, 'action', { max: 50 });
      eventService.performAction(eventId, body);
      const freshEvent = eventService.getEvent(eventId);
      const freshRound = eventService.getCurrentRound(freshEvent);

      if (['SHOW_AWARD', 'OPEN_VOTING', 'REOPEN_VOTING', 'START_RUNOFF', 'NEXT_AWARD', 'RESET_CURRENT_ROUND'].includes(action) && freshRound) {
        masked.initialise(freshRound);
      }
      if (action === 'LOCK_VOTING' && freshRound) masked.force(freshRound);
      if (action === 'ROTATE_DISPLAY_TOKEN') {
        sessionService.revokeEventRole(eventId, 'DISPLAY');
        hub.closeWhere((connection) => connection.eventId === eventId && connection.role === 'DISPLAY');
      }
      if (action === 'RESTART_EVENT') {
        hub.closeWhere((connection) => connection.eventId === eventId && connection.role === 'PARTICIPANT');
      }
      logger.info('Admin event action', { eventId, action });
      hub.broadcastSnapshot(eventId);
      return sendJson(res, 200, buildAdminState(session, eventId));
    }

    if (method === 'POST' && pathname === '/api/admin/revoke-participant') {
      const session = sessionService.authenticate(req, 'ADMIN');
      validateCsrf(req, session, config);
      const body = object(await readJson(req, config.maxBodyBytes));
      const eventId = idText(body.eventId, 'eventId');
      const participantId = idText(body.participantId, 'participantId');
      joinService.revokeParticipant(eventId, participantId);
      hub.closeWhere((connection) => connection.session.participant_id === participantId);
      hub.broadcastSnapshot(eventId);
      return sendJson(res, 200, buildAdminState(session, eventId));
    }

    if (method === 'GET' && pathname === '/api/admin/export.csv') {
      sessionService.authenticate(req, 'ADMIN');
      const eventId = idText(url.searchParams.get('eventId'), 'eventId');
      const csv = eventService.exportCsv(eventId);
      return sendText(res, 200, csv, 'text/csv; charset=utf-8', {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="staff-awards-results.csv"',
      });
    }

    if (method === 'GET' && pathname === '/api/admin/join-qr.svg') {
      sessionService.authenticate(req, 'ADMIN');
      const eventId = idText(url.searchParams.get('eventId'), 'eventId');
      const svg = await createQrSvg(eventService.accessDetails(eventService.getEvent(eventId)).joinUrl);
      return sendText(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'no-store' });
    }

    if (method === 'GET' && pathname === '/api/admin/display-qr.svg') {
      sessionService.authenticate(req, 'ADMIN');
      const eventId = idText(url.searchParams.get('eventId'), 'eventId');
      const svg = await createQrSvg(eventService.accessDetails(eventService.getEvent(eventId)).displayUrl);
      return sendText(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'no-store' });
    }

    if (method === 'POST' && pathname === '/api/participant/join') {
      validateOrigin(req, config);
      const body = object(await readJson(req, config.maxBodyBytes));
      const existing = sessionService.authenticate(req, 'PARTICIPANT', { optional: true });
      let event;
      if (body.token) {
        limiter.check('token-exchange', ip, 60, 10 * 60_000);
        event = joinService.eventFromJoinToken(String(body.token));
      } else {
        limiter.check('manual-code', ip, 30, 10 * 60_000);
        event = joinService.eventFromManualCode(body.code);
      }
      const joined = joinService.joinParticipant(event, existing);
      const session = joined.resumed ? joined.session : { ...joined.session, csrfToken: joined.csrfToken };
      hub.broadcastSnapshot(event.id, ['ADMIN']);
      const headers = joined.cookie ? { 'Set-Cookie': joined.cookie } : {};
      return sendJson(res, 200, buildParticipantState(session), headers);
    }

    if (method === 'GET' && pathname === '/api/participant/state') {
      const session = sessionService.authenticate(req, 'PARTICIPANT');
      return sendJson(res, 200, buildParticipantState(session));
    }

    if (method === 'GET' && pathname === '/api/participant/stream') {
      const session = sessionService.authenticate(req, 'PARTICIPANT');
      hub.connect({ req, res, session, role: 'PARTICIPANT', eventId: session.event_id, snapshot: () => buildParticipantState(session) });
      return true;
    }

    if (method === 'PUT' && pathname === '/api/participant/vote') {
      const session = sessionService.authenticate(req, 'PARTICIPANT');
      validateCsrf(req, session, config);
      limiter.check('vote', session.id, 10, 60_000);
      const body = await readJson(req, config.maxBodyBytes);
      const result = votingService.submit(session, body);
      const round = eventService.getRound(result.roundId);
      masked.queue(round);
      hub.broadcastSnapshot(session.event_id, ['ADMIN']);
      hub.broadcast(session.event_id, ['PARTICIPANT', 'DISPLAY'], 'vote-progress', {
        eventVersion: eventService.getEvent(session.event_id).version,
        roundId: round.id,
        roundVersion: round.version,
        votesCast: resultService.voteCount(round.id),
      });
      return sendJson(res, 200, buildParticipantState(session));
    }

    if (method === 'POST' && pathname === '/api/participant/logout') {
      const session = sessionService.authenticate(req, 'PARTICIPANT');
      validateCsrf(req, session, config);
      sessionService.revoke(session.id);
      hub.closeWhere((connection) => connection.session.id === session.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionService.clearCookie('PARTICIPANT') });
    }

    if (method === 'POST' && pathname === '/api/display/join') {
      validateOrigin(req, config);
      limiter.check('token-exchange', ip, 60, 10 * 60_000);
      const body = object(await readJson(req, config.maxBodyBytes));
      const existing = sessionService.authenticate(req, 'DISPLAY', { optional: true });
      const event = joinService.eventFromDisplayToken(String(body.token ?? ''));
      const joined = joinService.joinDisplay(event, existing);
      const session = joined.resumed ? joined.session : { ...joined.session, csrfToken: joined.csrfToken };
      const headers = joined.cookie ? { 'Set-Cookie': joined.cookie } : {};
      return sendJson(res, 200, buildDisplayState(session), headers);
    }

    if (method === 'GET' && pathname === '/api/display/state') {
      const session = sessionService.authenticate(req, 'DISPLAY');
      return sendJson(res, 200, buildDisplayState(session));
    }

    if (method === 'GET' && pathname === '/api/display/stream') {
      const session = sessionService.authenticate(req, 'DISPLAY');
      hub.connect({ req, res, session, role: 'DISPLAY', eventId: session.event_id, snapshot: () => buildDisplayState(session) });
      return true;
    }

    if (method === 'GET' && pathname === '/api/display/join-qr.svg') {
      const session = sessionService.authenticate(req, 'DISPLAY');
      const event = eventService.getEvent(session.event_id);
      const svg = await createQrSvg(eventService.accessDetails(event).joinUrl);
      return sendText(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'no-store' });
    }

    return false;
  }

  let started = false;
  let stopped = false;
  return {
    config,
    server,
    services: { database, eventService, resultService, masked, sessionService, joinService, votingService, hub, limiter },
    async start() {
      if (started) return server.address();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          started = true;
          resolve();
        });
      });
      const address = server.address();
      logger.info('Staff Awards server started', { host: config.host, port: typeof address === 'object' ? address.port : config.port, node: process.version });
      return address;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      hub.onPresenceChange = () => {};
      hub.close();
      masked.close();
      limiter.close();
      if (started) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      database.checkpoint();
      database.close();
      logger.info('Staff Awards server stopped');
    },
  };
}
