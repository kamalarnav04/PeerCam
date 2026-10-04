/**
 * signaling.js — WebSocket client for the signaling server (shared module).
 *
 * Wraps a WebSocket so the camera and viewer pages don't have to deal with
 * connection drops:
 *   - connects to /ws on the same host the page came from (wss:// on https)
 *   - sends {type:'join', room, role} every time it (re)connects
 *   - reconnects automatically with exponential backoff (1s, 2s, 4s ... 10s)
 *   - reconnects immediately when the tab becomes visible / network returns
 *   - lets pages subscribe to messages by type:  signaling.on('offer', fn)
 *
 * Extra pseudo-events emitted besides server message types:
 *   'open'     — connected and join sent
 *   'close'    — connection lost (a reconnect will follow)
 *   'replaced' — the server closed us because the same role joined this room
 *                from another tab/device; we stop reconnecting so two tabs
 *                don't keep kicking each other out.
 */

const CLOSE_REPLACED = 4000; // must match server.js
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 10000;

// Room codes: 4–8 letters/digits, case-insensitive (must match server.js).
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

/** Uppercase and strip spaces/dashes, so "ab3 k9x" becomes "AB3K9X". */
export function normalizeRoomCode(input) {
  return String(input || '').toUpperCase().replace(/[\s-]/g, '');
}

export function isValidRoomCode(code) {
  return ROOM_CODE_RE.test(code);
}

export class Signaling {
  constructor({ room, role }) {
    this.room = room;
    this.role = role;
    this.handlers = new Map();
    this.ws = null;
    this.retryMs = MIN_RETRY_MS;
    this.retryTimer = null;
    this.stopped = false;

    // Phones throttle timers in background tabs; when the user comes back,
    // don't wait for the backoff timer — reconnect right away.
    const reconnectNow = () => {
      if (document.visibilityState === 'visible') this.reconnectIfNeeded();
    };
    document.addEventListener('visibilitychange', reconnectNow);
    window.addEventListener('online', reconnectNow);

    this.connect();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return this;
  }

  emit(type, payload) {
    for (const handler of this.handlers.get(type) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`Error in "${type}" handler:`, err);
      }
    }
  }

  /** Send a message object; returns false if not currently connected. */
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  connect() {
    clearTimeout(this.retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = MIN_RETRY_MS;
      this.send({ type: 'join', room: this.room, role: this.role });
      this.emit('open');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
    };

    ws.onclose = (event) => {
      if (ws !== this.ws) return; // an older socket we've already replaced
      if (this.stopped) return;
      if (event.code === CLOSE_REPLACED) {
        this.stopped = true;
        this.emit('replaced');
        return;
      }
      this.emit('close');
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
  }

  reconnectIfNeeded() {
    if (this.stopped || !this.ws) return;
    const state = this.ws.readyState;
    if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) this.connect();
  }

  /** Permanently disconnect (no more reconnects). */
  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }
}
