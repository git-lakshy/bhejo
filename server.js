const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROOM_EXPIRY = Number(process.env.ROOM_EXPIRY || 10 * 60 * 1000);
const MAX_ROOM_SIZE = 2;
const ROOM_CODE_LENGTH = 6;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function generateRoomCode() {
  let roomId = '';

  do {
    roomId = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      const randomIndex = Math.floor(Math.random() * ROOM_CHARS.length);
      roomId += ROOM_CHARS[randomIndex];
    }
  } while (rooms.has(roomId));

  return roomId;
}

function getRoom(roomId) {
  return roomId ? rooms.get(roomId) : null;
}

function removePeerFromRoom(roomId, ws) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  room.peers = room.peers.filter((peer) => peer !== ws);

  room.peers.forEach((peer) => send(peer, { type: 'peer-disconnected' }));

  if (room.peers.length === 0) {
    rooms.delete(roomId);
  }
}

function relayToPeer(roomId, sender, payload) {
  const room = getRoom(roomId);
  if (!room) {
    return;
  }

  room.peers.forEach((peer) => {
    if (peer !== sender) {
      send(peer, payload);
    }
  });
}

function handleCreateRoom(ws) {
  const roomId = generateRoomCode();

  ws.roomId = roomId;
  ws.role = 'sender';

  rooms.set(roomId, {
    createdAt: Date.now(),
    peers: [ws],
    pendingOffer: null
  });

  send(ws, {
    type: 'joined',
    roomId,
    peerId: 'peer1',
    role: 'sender'
  });
}

function handleJoinRoom(ws, roomId) {
  const normalizedRoomId = String(roomId || '').toUpperCase();
  const room = getRoom(normalizedRoomId);

  if (!room) {
    send(ws, { type: 'error', message: 'Invalid or expired room' });
    return;
  }

  if (room.peers.length >= MAX_ROOM_SIZE) {
    send(ws, { type: 'error', message: 'Room is full' });
    return;
  }

  ws.roomId = normalizedRoomId;
  ws.role = 'receiver';
  room.peers.push(ws);

  room.peers.forEach((peer, index) => {
    send(peer, {
      type: 'joined',
      roomId: normalizedRoomId,
      peerId: index === 0 ? 'peer1' : 'peer2',
      role: index === 0 ? 'sender' : 'receiver',
      peerCount: room.peers.length
    });
  });

  if (room.pendingOffer) {
    send(ws, { type: 'offer', offer: room.pendingOffer });
    room.pendingOffer = null;
  }
}

function handleMessage(ws, rawMessage) {
  let data;

  try {
    data = JSON.parse(rawMessage);
  } catch (error) {
    send(ws, { type: 'error', message: 'Invalid message format' });
    return;
  }

  if (data.type === 'ping') {
    send(ws, { type: 'pong' });
    return;
  }

  if (data.type === 'join') {
    if (data.createNew) {
      handleCreateRoom(ws);
      return;
    }

    handleJoinRoom(ws, data.roomId);
    return;
  }

  if (!ws.roomId || !rooms.has(ws.roomId)) {
    send(ws, { type: 'error', message: 'Room not found' });
    return;
  }

  if (data.type === 'offer') {
    const room = rooms.get(ws.roomId);
    const receiver = room.peers[1];

    if (receiver && receiver.readyState === WebSocket.OPEN) {
      send(receiver, data);
    } else {
      room.pendingOffer = data.offer;
    }
    return;
  }

  relayToPeer(ws.roomId, ws, data);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;

  send(ws, {
    type: 'connected',
    message: 'WebSocket connection established'
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    handleMessage(ws, message);
  });

  ws.on('close', () => {
    removePeerFromRoom(ws.roomId, ws);
  });

  ws.on('error', () => {
    removePeerFromRoom(ws.roomId, ws);
  });
});

const roomCleanupInterval = setInterval(() => {
  const now = Date.now();

  rooms.forEach((room, roomId) => {
    if (now - room.createdAt < ROOM_EXPIRY) {
      return;
    }

    room.peers.forEach((peer) => {
      send(peer, { type: 'room-expired' });
      peer.close();
    });

    rooms.delete(roomId);
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
  if (NODE_ENV !== 'production') {
    console.log(`Signaling server ready on ws://localhost:${PORT}`);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

function shutdown() {
  clearInterval(roomCleanupInterval);
  clearInterval(heartbeatInterval);
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
