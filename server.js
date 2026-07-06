const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('redis');
const promClient = require('prom-client');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROOM_EXPIRY = Number(process.env.ROOM_EXPIRY || 10 * 60 * 1000);
const MAX_ROOM_SIZE = 2;
const ROOM_CODE_LENGTH = 6;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'bhejo';
const ROOM_EVENT_CHANNEL = `${REDIS_PREFIX}:room-events`;
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun2.l.google.com:19302')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const ICE_TRANSPORT_POLICY = process.env.ICE_TRANSPORT_POLICY || 'all';
const ICE_CANDIDATE_POOL_SIZE = Number(process.env.ICE_CANDIDATE_POOL_SIZE || 10);
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const RELAY_ENABLED = process.env.RELAY_ENABLED !== 'false';
const RELAY_MAX_FILE_SIZE_BYTES = Number(process.env.RELAY_MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const RELAY_CHUNK_SIZE_BYTES = Number(process.env.RELAY_CHUNK_SIZE_BYTES || 12 * 1024);

class MemoryRoomStore {
  constructor(expiryMs) {
    this.expiryMs = expiryMs;
    this.rooms = new Map();
  }

  async createRoom(roomId, room) {
    if (this.rooms.has(roomId)) {
      return false;
    }

    this.rooms.set(roomId, { ...room });
    return true;
  }

  async getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }

    if (Date.now() - room.createdAt > this.expiryMs) {
      this.rooms.delete(roomId);
      return null;
    }

    return { ...room };
  }

  async joinRoom(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return { ok: false, reason: 'missing' };
    }

    if (room.peerCount >= MAX_ROOM_SIZE) {
      return { ok: false, reason: 'full' };
    }

    const updatedRoom = { ...room, peerCount: room.peerCount + 1 };
    this.rooms.set(roomId, updatedRoom);
    return { ok: true, room: updatedRoom };
  }

  async leaveRoom(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    if (room.peerCount <= 1) {
      this.rooms.delete(roomId);
      return;
    }

    this.rooms.set(roomId, { ...room, peerCount: room.peerCount - 1 });
  }

  async savePendingOffer(roomId, offer) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    this.rooms.set(roomId, { ...room, pendingOffer: offer });
  }

  async consumePendingOffer(roomId) {
    const room = await this.getRoom(roomId);
    if (!room || !room.pendingOffer) {
      return null;
    }

    this.rooms.set(roomId, { ...room, pendingOffer: null });
    return room.pendingOffer;
  }
}

class RedisRoomStore {
  constructor(client, expiryMs, prefix) {
    this.client = client;
    this.expiryMs = expiryMs;
    this.prefix = prefix;
  }

  roomKey(roomId) {
    return `${this.prefix}:room:${roomId}`;
  }

  async createRoom(roomId, room) {
    const result = await this.client.set(this.roomKey(roomId), JSON.stringify(room), {
      PX: this.expiryMs,
      NX: true
    });

    return result === 'OK';
  }

  async getRoom(roomId) {
    const raw = await this.client.get(this.roomKey(roomId));
    return raw ? JSON.parse(raw) : null;
  }

  async updateRoom(roomId, updateFn) {
    const key = this.roomKey(roomId);

    while (true) {
      await this.client.watch(key);
      const room = await this.getRoom(roomId);

      if (!room) {
        await this.client.unwatch();
        return null;
      }

      const updatedRoom = updateFn(room);
      const transaction = this.client.multi();

      if (updatedRoom) {
        transaction.set(key, JSON.stringify(updatedRoom), { PX: this.expiryMs });
      } else {
        transaction.del(key);
      }

      const result = await transaction.exec();
      if (result) {
        return { room, updatedRoom };
      }
    }
  }

  async joinRoom(roomId) {
    const result = await this.updateRoom(roomId, (room) => {
      if (room.peerCount >= MAX_ROOM_SIZE) {
        return room;
      }

      return { ...room, peerCount: room.peerCount + 1 };
    });

    if (!result) {
      return { ok: false, reason: 'missing' };
    }

    if (result.room.peerCount >= MAX_ROOM_SIZE) {
      return { ok: false, reason: 'full' };
    }

    return { ok: true, room: result.updatedRoom };
  }

  async leaveRoom(roomId) {
    await this.updateRoom(roomId, (room) => {
      if (room.peerCount <= 1) {
        return null;
      }

      return { ...room, peerCount: room.peerCount - 1 };
    });
  }

  async savePendingOffer(roomId, offer) {
    await this.updateRoom(roomId, (room) => ({ ...room, pendingOffer: offer }));
  }

  async consumePendingOffer(roomId) {
    const result = await this.updateRoom(roomId, (room) => {
      if (!room.pendingOffer) {
        return room;
      }

      return { ...room, pendingOffer: null };
    });

    if (!result || !result.room.pendingOffer) {
      return null;
    }

    return result.room.pendingOffer;
  }
}

function generateRoomCode() {
  let roomId = '';

  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CHARS.length);
    roomId += ROOM_CHARS[randomIndex];
  }

  return roomId;
}

function buildRtcConfig() {
  const iceServers = STUN_URLS.map((urls) => ({ urls }));

  if (TURN_URLS.length > 0) {
    iceServers.push({
      urls: TURN_URLS,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });
  }

  return {
    iceServers,
    iceTransportPolicy: ICE_TRANSPORT_POLICY,
    iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

function createMetrics() {
  const registry = new promClient.Registry();
  promClient.collectDefaultMetrics({ register: registry, prefix: 'bhejo_' });

  const websocketConnections = new promClient.Gauge({
    name: 'bhejo_websocket_connections',
    help: 'Active websocket client connections',
    registers: [registry]
  });

  const localRooms = new promClient.Gauge({
    name: 'bhejo_local_rooms',
    help: 'Rooms with at least one peer on this instance',
    registers: [registry]
  });

  const roomEvents = new promClient.Counter({
    name: 'bhejo_room_events_total',
    help: 'Room lifecycle events',
    labelNames: ['type'],
    registers: [registry]
  });

  const signalingMessages = new promClient.Counter({
    name: 'bhejo_signaling_messages_total',
    help: 'Signaling messages handled by the server',
    labelNames: ['type'],
    registers: [registry]
  });

  const transferEvents = new promClient.Counter({
    name: 'bhejo_transfer_events_total',
    help: 'Client-reported transfer events',
    labelNames: ['type', 'role'],
    registers: [registry]
  });

  const transferBytes = new promClient.Counter({
    name: 'bhejo_transfer_bytes_total',
    help: 'Client-reported file bytes transferred',
    labelNames: ['role'],
    registers: [registry]
  });

  return {
    registry,
    websocketConnections,
    localRooms,
    roomEvents,
    signalingMessages,
    transferEvents,
    transferBytes
  };
}

async function start() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, perMessageDeflate: false });
  const metrics = createMetrics();
  const sockets = new Map();
  const localRoomMembers = new Map();
  let roomStore = new MemoryRoomStore(ROOM_EXPIRY);
  let redisClient = null;
  let pubClient = null;
  let subClient = null;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  if (REDIS_URL) {
    redisClient = createClient({ url: REDIS_URL });
    const redisPublisher = createClient({ url: REDIS_URL });
    const redisSubscriber = createClient({ url: REDIS_URL });

    await Promise.all([
      redisClient.connect(),
      redisPublisher.connect(),
      redisSubscriber.connect()
    ]);

    roomStore = new RedisRoomStore(redisClient, ROOM_EXPIRY, REDIS_PREFIX);
    pubClient = redisPublisher;
    subClient = redisSubscriber;

    await subClient.subscribe(ROOM_EVENT_CHANNEL, (message) => {
      try {
        const event = JSON.parse(message);
        relayPublishedMessage(event);
      } catch (error) {
        console.error('Failed to process room event:', error);
      }
    });
  }

  function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function addSocketToRoom(roomId, socketId) {
    if (!localRoomMembers.has(roomId)) {
      localRoomMembers.set(roomId, new Set());
    }

    localRoomMembers.get(roomId).add(socketId);
    metrics.localRooms.set(localRoomMembers.size);
  }

  function removeSocketFromRoom(roomId, socketId) {
    const members = localRoomMembers.get(roomId);
    if (!members) {
      return;
    }

    members.delete(socketId);
    if (members.size === 0) {
      localRoomMembers.delete(roomId);
    }

    metrics.localRooms.set(localRoomMembers.size);
  }

  function relayPublishedMessage(event) {
    const members = localRoomMembers.get(event.roomId);
    if (!members) {
      return;
    }

    members.forEach((socketId) => {
      if (socketId === event.senderSocketId) {
        return;
      }

      send(sockets.get(socketId), event.payload);
    });
  }

  async function publishRoomEvent(roomId, senderSocketId, payload) {
    const event = { roomId, senderSocketId, payload };

    if (pubClient) {
      await pubClient.publish(ROOM_EVENT_CHANNEL, JSON.stringify(event));
      return;
    }

    relayPublishedMessage(event);
  }

  async function createRoom(ws) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const roomId = generateRoomCode();
      const created = await roomStore.createRoom(roomId, {
        createdAt: Date.now(),
        peerCount: 1,
        pendingOffer: null
      });

      if (!created) {
        continue;
      }

      ws.roomId = roomId;
      ws.role = 'sender';
      addSocketToRoom(roomId, ws.socketId);
      metrics.roomEvents.inc({ type: 'create' });

      send(ws, {
        type: 'joined',
        roomId,
        peerId: 'peer1',
        role: 'sender'
      });

      return;
    }

    send(ws, { type: 'error', message: 'Failed to create room' });
  }

  async function joinRoom(ws, roomId) {
    const normalizedRoomId = String(roomId || '').toUpperCase();
    const result = await roomStore.joinRoom(normalizedRoomId);

    if (!result) {
      send(ws, { type: 'error', message: 'Invalid or expired room' });
      metrics.roomEvents.inc({ type: 'join_missing' });
      return;
    }

    if (!result.ok) {
      const message = result.reason === 'full' ? 'Room is full' : 'Invalid or expired room';
      send(ws, { type: 'error', message });
      metrics.roomEvents.inc({ type: result.reason === 'full' ? 'join_full' : 'join_missing' });
      return;
    }

    ws.roomId = normalizedRoomId;
    ws.role = 'receiver';
    addSocketToRoom(normalizedRoomId, ws.socketId);
    metrics.roomEvents.inc({ type: 'join' });

    send(ws, {
      type: 'joined',
      roomId: normalizedRoomId,
      peerId: 'peer2',
      role: 'receiver',
      peerCount: result.room.peerCount
    });

    const pendingOffer = await roomStore.consumePendingOffer(normalizedRoomId);
    if (pendingOffer) {
      send(ws, { type: 'offer', offer: pendingOffer });
    }
  }

  async function removePeer(ws, reasonType) {
    if (!ws.roomId) {
      return;
    }

    const roomId = ws.roomId;
    ws.roomId = null;
    removeSocketFromRoom(roomId, ws.socketId);
    await roomStore.leaveRoom(roomId);
    metrics.roomEvents.inc({ type: reasonType || 'leave' });
    await publishRoomEvent(roomId, ws.socketId, { type: 'peer-disconnected' });
  }

  async function handleMessage(ws, rawMessage) {
    let data;

    try {
      data = JSON.parse(rawMessage);
    } catch (error) {
      send(ws, { type: 'error', message: 'Invalid message format' });
      return;
    }

    metrics.signalingMessages.inc({ type: data.type || 'unknown' });

    if (data.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (data.type === 'join') {
      if (data.createNew) {
        await createRoom(ws);
        return;
      }

      await joinRoom(ws, data.roomId);
      return;
    }

    if (!ws.roomId) {
      send(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (data.type === 'relay-file-metadata') {
      if (!RELAY_ENABLED) {
        send(ws, { type: 'relay-error', message: 'Relay mode is disabled on this deployment' });
        return;
      }

      if (Number(data.size || 0) > RELAY_MAX_FILE_SIZE_BYTES) {
        send(ws, {
          type: 'relay-error',
          message: `Relay mode supports files up to ${Math.round(RELAY_MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB`
        });
        return;
      }
    }

    if (data.type === 'offer') {
      await roomStore.savePendingOffer(ws.roomId, data.offer);
      const room = await roomStore.getRoom(ws.roomId);
      if (room && room.peerCount > 1) {
        await publishRoomEvent(ws.roomId, ws.socketId, data);
      }
      return;
    }

    await publishRoomEvent(ws.roomId, ws.socketId, data);
  }

  app.get('/api/config', (req, res) => {
    res.json({
      rtcConfig: buildRtcConfig(),
      roomCodeLength: ROOM_CODE_LENGTH,
      roomCodeAlphabet: ROOM_CHARS,
      redisEnabled: Boolean(REDIS_URL),
      monitoringEnabled: METRICS_ENABLED,
      publicBaseUrl: PUBLIC_BASE_URL,
      relay: {
        enabled: RELAY_ENABLED,
        maxFileSizeBytes: RELAY_MAX_FILE_SIZE_BYTES,
        chunkSizeBytes: RELAY_CHUNK_SIZE_BYTES
      }
    });
  });

  app.get('/health', async (req, res) => {
    let backend = 'memory';

    if (REDIS_URL) {
      backend = 'redis';
    }

    res.json({
      ok: true,
      backend,
      uptime: process.uptime(),
      websocketConnections: wss.clients.size,
      localRooms: localRoomMembers.size
    });
  });

  app.post('/api/events', (req, res) => {
    const { type, role, totalBytes } = req.body || {};
    const safeType = typeof type === 'string' ? type : 'unknown';
    const safeRole = typeof role === 'string' ? role : 'unknown';
    const safeBytes = Number(totalBytes || 0);

    metrics.transferEvents.inc({ type: safeType, role: safeRole });
    if (Number.isFinite(safeBytes) && safeBytes > 0) {
      metrics.transferBytes.inc({ role: safeRole }, safeBytes);
    }

    res.status(202).json({ ok: true });
  });

  if (METRICS_ENABLED) {
    app.get('/metrics', async (req, res) => {
      metrics.websocketConnections.set(wss.clients.size);
      metrics.localRooms.set(localRoomMembers.size);
      res.set('Content-Type', metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
    });
  }

  wss.on('connection', (ws) => {
    ws.socketId = crypto.randomUUID();
    ws.isAlive = true;
    sockets.set(ws.socketId, ws);
    metrics.websocketConnections.set(wss.clients.size);

    send(ws, {
      type: 'connected',
      message: 'WebSocket connection established'
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message) => {
      handleMessage(ws, message).catch((error) => {
        console.error('WebSocket message error:', error);
        send(ws, { type: 'error', message: 'Server error while handling message' });
      });
    });

    ws.on('close', () => {
      sockets.delete(ws.socketId);
      metrics.websocketConnections.set(wss.clients.size);
      removePeer(ws, 'disconnect').catch((error) => {
        console.error('Socket close cleanup failed:', error);
      });
    });

    ws.on('error', () => {
      sockets.delete(ws.socketId);
      metrics.websocketConnections.set(wss.clients.size);
      removePeer(ws, 'error').catch((cleanupError) => {
        console.error('Socket error cleanup failed:', cleanupError);
      });
    });
  });

  const roomWatcherInterval = setInterval(() => {
    const roomIds = Array.from(localRoomMembers.keys());
    roomIds.forEach((roomId) => {
      roomStore.getRoom(roomId).then((room) => {
        if (room) {
          return;
        }

        const members = localRoomMembers.get(roomId);
        if (!members) {
          return;
        }

        members.forEach((socketId) => {
          const ws = sockets.get(socketId);
          send(ws, { type: 'room-expired' });
          if (ws) {
            ws.close();
          }
        });
      }).catch((error) => {
        console.error('Room watcher failed:', error);
      });
    });
  }, 60 * 1000);

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30 * 1000);

  server.listen(PORT, HOST, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Signaling using ${REDIS_URL ? 'redis-backed rooms' : 'in-memory rooms'}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
    } else {
      console.error('Server error:', error);
    }

    process.exit(1);
  });

  async function shutdown() {
    clearInterval(roomWatcherInterval);
    clearInterval(heartbeatInterval);

    if (subClient) {
      await subClient.quit();
    }

    if (pubClient) {
      await pubClient.quit();
    }

    if (redisClient) {
      await redisClient.quit();
    }

    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown().catch(() => process.exit(1));
  });

  process.on('SIGTERM', () => {
    shutdown().catch(() => process.exit(1));
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
