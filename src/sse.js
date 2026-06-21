import { securityHeaders } from './security.js';

export class SSEHub {
  constructor(sessionService, logger, { heartbeatMs = 15000 } = {}) {
    this.sessions = sessionService;
    this.logger = logger;
    this.connections = new Set();
    this.sequence = 0;
    this.onPresenceChange = () => {};
    this.heartbeat = setInterval(() => this.keepAlive(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  connect({ req, res, session, role, eventId, snapshot }) {
    const sameSession = [...this.connections].filter((connection) => connection.session.id === session.id);
    if (sameSession.length >= 3) {
      res.writeHead(429, { ...securityHeaders({ api: true }), 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'TOO_MANY_STREAMS', message: 'Too many live connections for this session' } }));
      return;
    }

    res.writeHead(200, {
      ...securityHeaders({ sse: true }),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const connection = { req, res, session, role, eventId, snapshot, closed: false };
    this.connections.add(connection);
    this.send(connection, 'snapshot', snapshot(session));

    const close = () => this.remove(connection);
    req.on('close', close);
    res.on('close', close);
    res.on('error', close);
    this.onPresenceChange(eventId);
  }

  send(connection, type, payload) {
    if (connection.closed || connection.res.destroyed) return;
    this.sequence += 1;
    const body = JSON.stringify({ ...payload, serverTime: payload?.serverTime ?? new Date().toISOString() });
    try {
      connection.res.write(`id: ${this.sequence}\nevent: ${type}\ndata: ${body}\n\n`);
    } catch {
      this.remove(connection);
    }
  }

  broadcastSnapshot(eventId, roles = ['ADMIN', 'PARTICIPANT', 'DISPLAY']) {
    for (const connection of this.connections) {
      if (connection.eventId !== eventId || !roles.includes(connection.role)) continue;
      try { this.send(connection, 'snapshot', connection.snapshot(connection.session)); } catch (error) {
        this.logger.warn('Failed to build SSE snapshot', { role: connection.role, eventId, error });
        this.remove(connection);
      }
    }
  }

  broadcast(eventId, roles, type, payload) {
    for (const connection of this.connections) {
      if (connection.eventId !== eventId || !roles.includes(connection.role)) continue;
      const data = typeof payload === 'function' ? payload(connection) : payload;
      this.send(connection, type, data);
    }
  }

  presence(eventId) {
    const participants = new Set();
    const displays = new Set();
    const admins = new Set();
    for (const connection of this.connections) {
      if (connection.eventId !== eventId || connection.closed) continue;
      if (connection.role === 'PARTICIPANT') participants.add(connection.session.participant_id);
      if (connection.role === 'DISPLAY') displays.add(connection.session.id);
      if (connection.role === 'ADMIN') admins.add(connection.session.id);
    }
    return { connectedParticipants: participants.size, connectedDisplays: displays.size, connectedAdmins: admins.size };
  }

  closeWhere(predicate, type = 'session-revoked') {
    for (const connection of [...this.connections]) {
      if (!predicate(connection)) continue;
      this.send(connection, type, { message: 'Session ended' });
      this.remove(connection);
    }
  }

  keepAlive() {
    for (const connection of [...this.connections]) {
      if (connection.closed || connection.res.destroyed || !this.sessions.isActive(connection.session.id)) {
        this.remove(connection);
        continue;
      }
      try { connection.res.write(`: keepalive ${Date.now()}\n\n`); } catch { this.remove(connection); }
    }
  }

  remove(connection) {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    try { connection.res.end(); } catch {}
    this.onPresenceChange(connection.eventId);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const connection of [...this.connections]) this.remove(connection);
  }
}
