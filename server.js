/**
 * server.js — Home Security Camera server
 *
 * This server has two jobs, and NEITHER of them is carrying video:
 *
 *   1. Serve the static web pages in ./public (landing, camera, viewer).
 *   2. Act as a WebRTC *signaling* channel over WebSocket (/ws). Before two
 *      browsers can stream to each other peer-to-peer, they must exchange a few
 *      small messages: an "offer", an "answer", and some "ICE candidates"
 *      (possible network addresses). The server just relays those between the
 *      camera and the viewer in the same room. Once connected, audio/video
 *      flows directly phone → laptop and never touches this server.
 *
 * Why HTTPS? Browsers only allow camera/mic access (getUserMedia) in a
 * "secure context": https:// pages, or http://localhost. Your phone reaches
 * the laptop by its LAN IP (e.g. https://192.168.1.20:3000), so we need HTTPS
 * even on the local network. We generate a self-signed certificate on first
 * run; browsers will warn once, and you click through.
 *
 * Environment variables:
 *   PORT=3000        port to listen on
 *   HOST=0.0.0.0     interface to bind (default: all interfaces)
 *   USE_HTTP=1       serve plain HTTP instead of HTTPS — ONLY for when a reverse
 *                    proxy / tunnel in front of this server provides HTTPS
 *                    (phase 2, internet access).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const selfsigned = require('selfsigned');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // undefined = listen on all interfaces
const USE_HTTP = process.env.USE_HTTP === '1';
const CERT_DIR = path.join(__dirname, 'certs');

// ---------------------------------------------------------------------------
// Express: static files
// ---------------------------------------------------------------------------

const app = express();

if (USE_HTTP) {
  // Behind a reverse proxy, trust its X-Forwarded-* headers (one hop).
  app.set('trust proxy', 1);
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// TLS certificate (self-signed, generated once and cached in ./certs)
// ---------------------------------------------------------------------------

/** All non-internal IPv4 addresses of this machine, with interface names. */
function getLanAddresses() {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal) {
        result.push({ name, address: addr.address });
      }
    }
  }
  return result;
}

/**
 * Load the cached certificate, or generate a new one if it is missing, about
 * to expire, or doesn't cover one of this machine's current LAN IPs (your
 * router may hand the laptop a different IP on another day).
 */
async function loadOrCreateCertificate() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');

  const ips = ['127.0.0.1', ...getLanAddresses().map((a) => a.address)];

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const coversAllIps = ips.every((ip) => meta.ips.includes(ip));
    const msLeft = new Date(meta.notAfter) - Date.now();
    if (coversAllIps && msLeft > 7 * 24 * 60 * 60 * 1000) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch {
    // No cached certificate yet (or unreadable) — fall through and create one.
  }

  console.log('Generating a self-signed HTTPS certificate (one-time)...');
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + 365);

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'home-security-camera.local' }],
    {
      keySize: 2048,
      algorithm: 'sha256', // the library defaults to sha1, which browsers reject
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          // Subject Alternative Names: the hostnames/IPs this cert is valid for.
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            ...ips.map((ip) => ({ type: 7, ip })),
          ],
        },
      ],
    }
  );

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips, notAfter }, null, 2));
  return { key: pems.private, cert: pems.cert };
}

// ---------------------------------------------------------------------------
// Signaling: rooms
// ---------------------------------------------------------------------------
//
// A room holds at most one camera and one viewer:
//   rooms: Map<roomCode, { camera: WebSocket|null, viewer: WebSocket|null }>
//
// Messages are JSON objects with a "type":
//   client → server   join {room, role}        enter a room as camera/viewer
//                     offer {description}      relayed to the other peer
//                     answer {description}     relayed to the other peer
//                     candidate {candidate}    relayed to the other peer
//   server → client   joined {room, role, peerPresent}
//                     peer-joined              the other side is (now) present
//                     peer-left                the other side went away
//                     error {message}
//
// Reload robustness:
//   - If a role is already taken in a room, the NEW connection wins and the
//     old one is closed with code 4000. A reloaded tab therefore always gets
//     its slot back, even if the server hasn't noticed the old tab is gone.
//   - Every time both slots are filled, both peers get "peer-joined". The
//     camera always responds by creating a brand-new peer connection and
//     sending a fresh offer, so either side can reload at any time.

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
const ROLES = new Set(['camera', 'viewer']);
const CLOSE_REPLACED = 4000;

const rooms = new Map();

const otherRole = (role) => (role === 'camera' ? 'viewer' : 'camera');

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleJoin(ws, msg) {
  const room = typeof msg.room === 'string' ? msg.room.toUpperCase() : '';
  const role = msg.role;
  if (!ROOM_CODE_RE.test(room)) return send(ws, { type: 'error', message: 'Invalid room code' });
  if (!ROLES.has(role)) return send(ws, { type: 'error', message: 'Invalid role' });

  leaveRoom(ws); // in case this socket was already in a room

  if (!rooms.has(room)) rooms.set(room, { camera: null, viewer: null });
  const slots = rooms.get(room);

  // Same role already present (e.g. the old tab before a reload)? Kick it.
  const previous = slots[role];
  if (previous && previous !== ws) {
    previous.room = null; // detach first so its 'close' handler is a no-op
    previous.role = null;
    previous.close(CLOSE_REPLACED, 'Replaced by a newer connection');
  }

  slots[role] = ws;
  ws.room = room;
  ws.role = role;

  const peer = slots[otherRole(role)];
  send(ws, { type: 'joined', room, role, peerPresent: Boolean(peer) });
  console.log(`[${room}] ${role} joined${peer ? ' (peer present)' : ''}`);

  if (peer) {
    send(peer, { type: 'peer-joined' });
    send(ws, { type: 'peer-joined' });
  }
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const slots = rooms.get(ws.room);
  if (slots && slots[ws.role] === ws) {
    slots[ws.role] = null;
    send(slots[otherRole(ws.role)], { type: 'peer-left' });
    console.log(`[${ws.room}] ${ws.role} left`);
    if (!slots.camera && !slots.viewer) rooms.delete(ws.room);
  }
  ws.room = null;
  ws.role = null;
}

/** Forward offer/answer/candidate to the other peer in the same room. */
function relay(ws, msg) {
  if (!ws.room) return send(ws, { type: 'error', message: 'Join a room first' });
  const peer = rooms.get(ws.room)?.[otherRole(ws.role)];
  if (!peer) return; // other side not here (yet); it will trigger a fresh offer when it joins

  // Forward only the fields we expect, not whatever the client sent.
  if (msg.type === 'candidate') {
    send(peer, { type: 'candidate', candidate: msg.candidate });
  } else {
    send(peer, { type: msg.type, description: msg.description });
  }
}

function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws) => {
    ws.room = null;
    ws.role = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: 'error', message: 'Invalid JSON' });
      }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'join':
          return handleJoin(ws, msg);
        case 'offer':
        case 'answer':
        case 'candidate':
          return relay(ws, msg);
        default:
          return send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => {}); // 'close' follows; avoid crashing on socket errors
  });

  // Heartbeat: a phone that sleeps or drops off Wi-Fi often doesn't close its
  // socket cleanly. Ping every 30s; anything that didn't pong since the last
  // ping is terminated, which frees its room slot and notifies the other peer.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const server = USE_HTTP
    ? http.createServer(app)
    : https.createServer(await loadOrCreateCertificate(), app);

  attachSignaling(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to another number.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const scheme = USE_HTTP ? 'http' : 'https';
    console.log(`\nHome Security Camera server running (${scheme.toUpperCase()}).\n`);
    console.log(`  This computer:   ${scheme}://localhost:${PORT}`);
    for (const { name, address } of getLanAddresses()) {
      console.log(`  On your network: ${scheme}://${address}:${PORT}   (${name})`);
    }
    if (!USE_HTTP) {
      console.log('\nThe certificate is self-signed: each device shows a one-time');
      console.log('"connection not private" warning. Choose Advanced -> Proceed.');
    }
    console.log('\nPress Ctrl+C to stop.\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
