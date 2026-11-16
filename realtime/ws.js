'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function required(name, value) {
  if (!value) throw new Error(`realtime/ws missing dependency: ${name}`);
  return value;
}

function createRealtimeServer(deps) {
  const server = required('server', deps.server);
  const db = required('db', deps.db);
  const modbus = required('modbus', deps.modbus);
  const authService = required('authService', deps.authService);
  const applyAuthBypass = required('applyAuthBypass', deps.applyAuthBypass);
  const wss = new WebSocketServer({ noServer: true });
  const eventStats = new Map();

  function webSocketToken(req) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      return url.searchParams.get('token');
    } catch (_) {
      return null;
    }
  }

  function authenticateWebSocket(req) {
    const token = webSocketToken(req);
    if (token) {
      try { const claims=authService.verifyAccessToken(token);return claims.portal_only?null:claims; } catch (_) {}
    }
    applyAuthBypass(req);
    return req.auth || null;
  }

  function onUpgrade(req, socket, head) {
    const auth = authenticateWebSocket(req);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    req.auth = auth;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.auth = auth;
      ws.authToken=webSocketToken(req);
      wss.emit('connection', ws, req);
    });
  }

  // BUG-15: Add eventId, timestamp, sourceService to every broadcast.
  function currentLinkedAccess(ws){
    if(!ws.auth?.system_link_id)return true;
    try{ws.auth=authService.verifyAccessToken(ws.authToken);return true;}
    catch{ws.close(1008,'Access revoked');return false;}
  }
  function wsBroadcast(type, data) {
    const now = new Date().toISOString();
    const prev = eventStats.get(type) || { type, count: 0, firstSeen: now, lastSeen: null };
    eventStats.set(type, {
      ...prev,
      count: prev.count + 1,
      lastSeen: now,
      sample: data,
    });
    const envelope = {
      type,
      data,
      eventId: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      timestamp: now,
      sourceService: 'ironbend-server',
    };
    const msg = JSON.stringify(envelope);
    wss.clients.forEach(ws => { if (ws.readyState === 1&&currentLinkedAccess(ws)) ws.send(msg); });
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.auth = req.auth;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'machines_state', data: modbus.getAllState() }));
  });

  // Keeps connections alive through Render's 60s nginx timeout.
  const wsHeartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if(!currentLinkedAccess(ws))return;
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);
  wsHeartbeat.unref?.();

  modbus.onUpdate((machineId, state) => {
    db.prepare(`UPDATE machines SET status=?, counter=?, last_seen=? WHERE id=?`)
      .run(state.status, state.counter, state.lastSeen, machineId);
    const machine = db.prepare('SELECT current_item_id FROM machines WHERE id=?').get(machineId);
    if (machine?.current_item_id) {
      db.prepare('UPDATE items SET produced_qty=? WHERE id=?').run(state.counter, machine.current_item_id);
    }
    wsBroadcast('machine_update', state);
  });

  server.on('upgrade', onUpgrade);

  function close() {
    server.off?.('upgrade', onUpgrade);
    clearInterval(wsHeartbeat);
    for (const client of wss.clients) client.terminate();
    try {
      wss.close();
    } catch (error) {
      if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
  }

  function getEventStats() {
    return [...eventStats.values()].sort((a, b) => String(a.type).localeCompare(String(b.type)));
  }

  return {
    wss,
    wsBroadcast,
    getEventStats,
    close,
  };
}

module.exports = { createRealtimeServer };
