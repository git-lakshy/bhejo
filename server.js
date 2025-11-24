const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();

// Environment variables
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const ROOM_EXPIRY = parseInt(process.env.ROOM_EXPIRY || '600000', 10); // 10 minutes default
const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || '2', 10);
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10); // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10); // 100 requests per window

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (HTTPS_ENABLED) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limiting (simple in-memory)
const rateLimitMap = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const key = ip;
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  const limit = rateLimitMap.get(key);
  
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  limit.count++;
  return true;
}

// Cleanup rate limit map
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of rateLimitMap.entries()) {
    if (now > limit.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW * 2);

// Rate limiting middleware
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

// Serve static files
app.use(express.static('public', {
  maxAge: NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
  lastModified: true
}));

// Create HTTP or HTTPS server
let server;
if (HTTPS_ENABLED && SSL_CERT_PATH && SSL_KEY_PATH) {
  try {
    const cert = fs.readFileSync(SSL_CERT_PATH);
    const key = fs.readFileSync(SSL_KEY_PATH);
    server = https.createServer({ cert, key }, app);
    console.log('HTTPS server enabled');
  } catch (error) {
    console.error('Failed to load SSL certificates, falling back to HTTP:', error.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// WebSocket server for signaling
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false, // Disable compression for lower latency
  clientTracking: true
});

// Room management
const rooms = new Map();

// Generate secure room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Cleanup expired rooms
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_EXPIRY) {
      // Close all connections in expired room
      room.peers.forEach(peer => {
        if (peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(JSON.stringify({ type: 'room-expired' }));
            peer.close();
          } catch (error) {
            // Ignore errors when closing
          }
        }
      });
      rooms.delete(roomId);
      cleaned++;
    }
  }
  if (cleaned > 0 && NODE_ENV === 'development') {
    console.log(`Cleaned up ${cleaned} expired room(s)`);
  }
}, 60000); // Check every minute

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  if (NODE_ENV === 'development') {
    console.log(`New WebSocket connection from ${ip}`);
  }
  
  let currentRoom = null;
  let peerId = null;
  let isAlive = true;

  // Heartbeat to detect dead connections
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join':
          handleJoin(ws, data);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(ws, data);
          break;
        case 'file-metadata':
        case 'chunk':
        case 'transfer-complete':
        case 'transfer-error':
          broadcastToRoom(currentRoom, ws, data);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default:
          if (NODE_ENV === 'development') {
            console.log('Unknown message type:', data.type);
          }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Invalid message format' 
        }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    // Connection closed
    
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.peers = room.peers.filter(p => p !== ws);
      
      // Notify other peer
      room.peers.forEach(peer => {
        if (peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(JSON.stringify({ type: 'peer-disconnected' }));
          } catch (error) {
            // Ignore errors
          }
        }
      });

      // Cleanup empty rooms
      if (room.peers.length === 0) {
        rooms.delete(currentRoom);
      }
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${ip}:`, error.message || error);
  });
  
  // Send welcome message on connection
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ 
        type: 'connected',
        message: 'WebSocket connection established'
      }));
    } catch (error) {
      console.error('Error sending welcome message:', error);
    }
  }

  function handleJoin(ws, data) {
    const { roomId, createNew } = data;

    if (createNew) {
      // Create new room
      const newRoomId = generateRoomCode();
      peerId = 'peer1';
      currentRoom = newRoomId;
      
      rooms.set(newRoomId, {
        peers: [ws],
        createdAt: Date.now(),
        peerIds: new Map([[ws, 'peer1']]),
        pendingOffer: null,
        pendingAnswer: null
      });

      ws.send(JSON.stringify({
        type: 'joined',
        roomId: newRoomId,
        peerId: 'peer1',
        role: 'sender'
      }));
    } else if (roomId && rooms.has(roomId)) {
      // Join existing room
      const room = rooms.get(roomId);
      
      if (room.peers.length >= MAX_ROOM_SIZE) {
        console.warn(`Room ${roomId} is full`);
        ws.send(JSON.stringify({
          type: 'error',
          message: `Room is full (${MAX_ROOM_SIZE} peers maximum). This is a peer-to-peer transfer, so only one sender and one receiver can be in a room.`
        }));
        return;
      }
      
      // Peer joined room

      peerId = 'peer2';
      currentRoom = roomId;
      room.peers.push(ws);
      room.peerIds.set(ws, 'peer2');

      // Notify both peers
      room.peers.forEach((peer, index) => {
        if (peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(JSON.stringify({
              type: 'joined',
              roomId: roomId,
              peerId: room.peerIds.get(peer),
              role: index === 0 ? 'sender' : 'receiver',
              peerCount: room.peers.length
            }));
          } catch (error) {
            // Ignore errors
          }
        }
      });
      
      // If there's a pending offer, send it to the receiver
      if (room.pendingOffer) {
        // Sending pending offer
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'offer',
              offer: room.pendingOffer
            }));
            room.pendingOffer = null;
          } catch (error) {
            console.error('Error sending pending offer:', error);
          }
        }
      }
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid or expired room'
      }));
    }
  }

  function handleSignaling(ws, data) {
    if (!currentRoom || !rooms.has(currentRoom)) {
      // No room for signaling message
      return;
    }

    const room = rooms.get(currentRoom);
    
    // Handle offer - always forward to receiver if exists
    if (data.type === 'offer') {
      // Received offer
      const receiver = room.peers.find((p, i) => i === 1); // Receiver is second peer
      if (receiver && receiver.readyState === WebSocket.OPEN) {
        // Receiver is ready, forward immediately
        try {
          receiver.send(JSON.stringify(data));
          // Forwarded offer
        } catch (error) {
          console.error('Error forwarding offer:', error);
        }
      } else if (receiver) {
        // Receiver exists but not ready, store offer
        room.pendingOffer = data.offer;
        // Stored offer
      } else {
        // No receiver yet, store offer
        room.pendingOffer = data.offer;
        // Stored offer
      }
      return;
    }
    
    // Handle answer - always forward to sender
    if (data.type === 'answer') {
      // Received answer
      const sender = room.peers[0]; // Sender is first peer
      if (sender && sender.readyState === WebSocket.OPEN) {
        // Sender is ready, forward immediately
        try {
          sender.send(JSON.stringify(data));
          // Forwarded answer
        } catch (error) {
          console.error('Error forwarding answer:', error);
        }
      } else {
        // Sender not ready yet, store answer
        room.pendingAnswer = data.answer;
        // Stored answer
      }
      return;
    }
    
    // Forward other signaling messages (ICE candidates, etc.)
    if (data.type === 'ice-candidate') {
      // Received ICE candidate
    }
    
    room.peers.forEach(peer => {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(JSON.stringify(data));
          if (data.type === 'ice-candidate') {
            // Forwarded ICE candidate
          }
        } catch (error) {
          console.error('Error forwarding signaling message:', error);
        }
      }
    });
  }

  function broadcastToRoom(roomId, sender, data) {
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.peers.forEach(peer => {
      if (peer !== sender && peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(JSON.stringify(data));
        } catch (error) {
          // Ignore errors
        }
      }
    });
  }
});

// Heartbeat interval for WebSocket connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // 30 seconds

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    connections: wss.clients.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// API endpoint for server info
app.get('/api/info', (req, res) => {
  const localIP = getLocalIPAddress();
  res.json({
    version: '1.0.0',
    environment: NODE_ENV,
    https: HTTPS_ENABLED,
    roomExpiry: ROOM_EXPIRY,
    maxRoomSize: MAX_ROOM_SIZE,
    networkIP: localIP,
    port: PORT
  });
});

// Get local IP address for network access
function getLocalIPAddress() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Start server - bind to 0.0.0.0 to allow network access
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const localIP = getLocalIPAddress();
  console.log(`🚀 Server running on ${HTTPS_ENABLED ? 'https' : 'http'}://localhost:${PORT}`);
  if (HOST === '0.0.0.0' && localIP !== 'localhost') {
    console.log(`🌐 Network access: ${HTTPS_ENABLED ? 'https' : 'http'}://${localIP}:${PORT}`);
    console.log(`📱 Access from other devices: ${HTTPS_ENABLED ? 'https' : 'http'}://${localIP}:${PORT}`);
  }
  console.log(`📡 WebSocket server ready for signaling`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  if (NODE_ENV === 'production') {
    console.log(`🔒 Production mode enabled`);
  }
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use!`);
    console.error(`💡 Try one of these solutions:`);
    console.error(`   1. Kill the process using port ${PORT}:`);
    console.error(`      Windows: netstat -ano | findstr :${PORT} then taskkill /PID <PID> /F`);
    console.error(`   2. Use a different port: PORT=3001 npm start`);
    console.error(`   3. Find and stop the other server`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});
