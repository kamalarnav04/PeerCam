/**
 * camera.js — runs on the device acting as the CAMERA (your phone).
 *
 * Flow:
 *   1. Pick a room code (from ?room= in the URL, or generate a new one and put
 *      it in the URL so reloading the page keeps the same room).
 *   2. getUserMedia → show the local preview with a ● LIVE badge.
 *   3. Connect to the signaling server as role "camera".
 *   4. Whenever a viewer is present ("peer-joined"), build a fresh
 *      RTCPeerConnection, attach our camera/mic tracks and send an OFFER.
 *      The viewer replies with an ANSWER; both sides trade ICE candidates;
 *      then video flows directly to the viewer.
 *
 * Extras on top of the stream:
 *   - a WebRTC *data channel* ("control") straight to the viewer, used to send
 *     this phone's status (battery, uptime, ...) and to receive talk on/off
 *   - two-way talk: the viewer's microphone arrives as an incoming audio track
 *     and is played through the phone speaker
 *   - live TX stats (what we're sending) from getStats()
 */

import { ICE_SERVERS } from './config.js';
import { Signaling, normalizeRoomCode, isValidRoomCode } from './signaling.js';
import { startStatsMonitor } from './stats.js';
import { startClock, setText, formatDuration, formatBitrate } from './hud.js';

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const liveBadge = $('live-badge');
const talkBadge = $('talk-badge');
const nodeState = $('node-state');
const statusEl = $('status');
const errorEl = $('error');
const talkbackAudio = $('talkback');
const enableAudioBtn = $('enable-audio');
const el = {
  link: $('st-link'),
  tx: $('st-tx'),
  uptime: $('st-uptime'),
  battery: $('st-battery'),
  wake: $('st-wake'),
  hudTx: $('hud-tx'),
};

startClock();

// Match the preview box to the camera's real shape (portrait or landscape).
function fitFeed() {
  if (preview.videoWidth && preview.videoHeight) {
    $('feed').style.setProperty('--ar', (preview.videoWidth / preview.videoHeight).toFixed(4));
  }
}
preview.addEventListener('loadedmetadata', fitFeed);
preview.addEventListener('resize', fitFeed);

// ---- Room code --------------------------------------------------------------
// 32 characters without look-alikes (no O/0, I/1). 256 is divisible by 32, so
// `byte % 32` picks every character with equal probability.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function getOrCreateRoomCode() {
  const fromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
  if (isValidRoomCode(fromUrl)) return fromUrl;
  const code = generateRoomCode();
  // Put the code in the URL without reloading → a reload rejoins the same room.
  history.replaceState(null, '', `?room=${code}`);
  return code;
}

const room = getOrCreateRoomCode();
$('room-code').textContent = room;
$('hud-room').textContent = room;
const viewerUrl = `${location.origin}/viewer.html?room=${room}`;
$('viewer-link').textContent = viewerUrl;
$('viewer-link').href = viewerUrl;

// ---- State ------------------------------------------------------------------
let localStream = null;
let signaling = null;
let pc = null; // the current RTCPeerConnection (one viewer at a time)
let dataChannel = null; // control channel to the current viewer
let stopStats = null;
let pendingCandidates = []; // ICE candidates that arrived before the answer
let streamStartedAt = 0;

/** Status line + the colored pill in the top bar. state: idle|wait|ok|warn|error */
function setStatus(text, state = 'wait') {
  setText(statusEl, text);
  const pill = { idle: 'STANDBY', wait: 'STANDBY', ok: 'STREAMING', warn: 'DEGRADED', error: 'OFFLINE' }[state];
  setText(nodeState, pill);
  nodeState.dataset.state = state;
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = false;
  liveBadge.hidden = true;
  setStatus('Not streaming', 'error');
}

// ---- Camera -----------------------------------------------------------------
async function startCamera() {
  // getUserMedia only exists in a secure context (https:// or localhost).
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError(
      'Camera access is blocked because this page is not secure. ' +
        'Open it with https:// (e.g. https://<laptop-ip>:3000), not http://.'
    );
    return false;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment', // back camera on phones
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    const reasons = {
      NotAllowedError: 'Camera/microphone permission was denied. Allow it in your browser settings and reload.',
      NotFoundError: 'No camera or microphone was found on this device.',
      NotReadableError: 'The camera is in use by another app. Close it and reload.',
    };
    showError(reasons[err.name] || `Could not start the camera: ${err.message}`);
    return false;
  }

  preview.srcObject = localStream; // muted + playsinline in the HTML so it autoplays
  liveBadge.hidden = false;
  streamStartedAt = Date.now();

  // If the camera is unplugged/revoked, stop claiming to be live.
  for (const track of localStream.getTracks()) {
    track.addEventListener('ended', () => showError(`The ${track.kind} track stopped. Reload to restart.`));
  }
  return true;
}

// ---- Device status (sent to the viewer over the data channel) -----------------
let battery = null; // BatteryManager: Android Chrome / desktop Chromium only
let wakeLock = null;

async function initBattery() {
  if (!navigator.getBattery) return;
  try {
    battery = await navigator.getBattery();
    battery.addEventListener('levelchange', sendStatus);
    battery.addEventListener('chargingchange', sendStatus);
  } catch {
    battery = null;
  }
}

function deviceStatus() {
  const settings = localStream?.getVideoTracks()[0]?.getSettings() || {};
  const ua = navigator.userAgent;
  return {
    type: 'status',
    uptime: Math.round((Date.now() - streamStartedAt) / 1000),
    battery: battery ? { level: battery.level, charging: battery.charging } : null,
    network: navigator.connection?.type || null, // 'wifi' | 'cellular' (Android Chrome)
    netSpeed: navigator.connection?.effectiveType || null, // speed class estimate, e.g. '4g'
    wakeLock: Boolean(wakeLock && !wakeLock.released),
    device: navigator.userAgentData?.platform || (/(iPhone|iPad|Android|Windows|Mac|Linux)/.exec(ua) || [])[1] || null,
    video: settings.width ? { width: settings.width, height: settings.height, facing: settings.facingMode || null } : null,
  };
}

function sendStatus() {
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify(deviceStatus()));
}

function renderLocalStatus() {
  if (streamStartedAt) setText(el.uptime, formatDuration((Date.now() - streamStartedAt) / 1000));
  if (battery) {
    setText(el.battery, `${Math.round(battery.level * 100)}%${battery.charging ? ' ⚡ CHARGING' : ''}`);
  } else {
    setText(el.battery, 'N/A');
  }
  const held = Boolean(wakeLock && !wakeLock.released);
  setText(el.wake, held ? 'KEPT AWAKE' : 'MAY SLEEP');
  el.wake.dataset.state = held ? 'ok' : 'warn';
}

setInterval(renderLocalStatus, 1000);
setInterval(sendStatus, 5000);

// ---- Keep the phone screen awake ------------------------------------------
// Mobile browsers pause the camera when the screen turns off or the tab is in
// the background. The Screen Wake Lock API keeps the screen on while this page
// is visible. It's released automatically when hidden, so re-request on return.
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      renderLocalStatus();
      sendStatus();
    });
  } catch {
    // Not fatal (e.g. battery saver). The README explains how to keep it on.
  }
  renderLocalStatus();
  sendStatus();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStream) requestWakeLock();
});

// ---- Two-way talk: play the viewer's voice ------------------------------------
// Browsers may refuse to play sound until the user has tapped the page. If so,
// show a button; one tap unlocks audio for the rest of the session.
function playTalkback() {
  talkbackAudio.play().then(
    () => { enableAudioBtn.hidden = true; },
    () => { enableAudioBtn.hidden = false; }
  );
}

enableAudioBtn.addEventListener('click', playTalkback);

function handleControlMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.type === 'talk') {
    talkBadge.hidden = !msg.active;
    if (msg.active) playTalkback();
  }
}

// ---- WebRTC -----------------------------------------------------------------
function closePeer() {
  if (stopStats) stopStats();
  stopStats = null;
  if (dataChannel) {
    dataChannel.onmessage = null;
    dataChannel.close();
  }
  dataChannel = null;
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.close();
  }
  pc = null;
  pendingCandidates = [];
  talkBadge.hidden = true;
  talkbackAudio.srcObject = null;
  setText(el.link, '--');
  setText(el.tx, '--');
  setText(el.hudTx, 'TX --');
}

function renderTxStats(s) {
  const res = s.width ? `${s.height}p` : '--';
  const fps = s.fps != null ? `${Math.round(s.fps)}fps` : '--';
  setText(el.tx, `${res} · ${fps} · ${formatBitrate(s.bitrateKbps)}`);
  setText(el.hudTx, `TX ${res} · ${fps} · ${formatBitrate(s.bitrateKbps)}`);
  setText(el.link, s.link ? `${s.link}${s.rttMs != null ? ` · ${Math.round(s.rttMs)}ms` : ''}` : 'NEGOTIATING');
}

/** Start a fresh connection to the viewer: create the peer connection and send an offer. */
async function startCall() {
  closePeer(); // a reload on either side means the old connection is useless

  const thisPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc = thisPc;

  // Send our camera + mic tracks. The audio transceiver is two-way
  // (sendrecv), which lets the viewer talk back without renegotiating.
  for (const track of localStream.getTracks()) {
    thisPc.addTrack(track, localStream);
  }

  // Control channel. Created by the offerer, so it's part of the offer.
  const channel = thisPc.createDataChannel('control');
  dataChannel = channel;
  channel.onopen = sendStatus;
  channel.onmessage = handleControlMessage;

  // The viewer's microphone (two-way talk) arrives as an incoming audio track.
  thisPc.ontrack = (event) => {
    if (event.track.kind !== 'audio') return;
    talkbackAudio.srcObject = new MediaStream([event.track]);
    playTalkback();
  };

  // Each network address candidate we discover goes to the viewer.
  thisPc.onicecandidate = (event) => {
    if (event.candidate) signaling.send({ type: 'candidate', candidate: event.candidate });
  };

  thisPc.onconnectionstatechange = () => {
    const state = thisPc.connectionState;
    if (state === 'connected') {
      setStatus('Viewer connected: streaming', 'ok');
      if (!stopStats) stopStats = startStatsMonitor(thisPc, 'outbound', renderTxStats);
    } else if (state === 'connecting') {
      setStatus('Connecting to viewer…', 'wait');
    } else if (state === 'disconnected') {
      setStatus('Viewer connection interrupted…', 'warn');
    } else if (state === 'failed') {
      setStatus('Connection to viewer failed. Waiting for it to reconnect…', 'error');
    }
  };

  setStatus('Viewer found. Connecting…', 'wait');
  const offer = await thisPc.createOffer();
  if (pc !== thisPc) return; // superseded by a newer startCall() meanwhile
  await thisPc.setLocalDescription(offer);
  signaling.send({ type: 'offer', description: thisPc.localDescription });
}

async function handleAnswer(description) {
  if (!pc || pc.signalingState !== 'have-local-offer') return; // stale answer
  await pc.setRemoteDescription(description);
  for (const candidate of pendingCandidates) await addCandidate(candidate);
  pendingCandidates = [];
}

async function addCandidate(candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) {
    pendingCandidates.push(candidate); // too early; apply after the answer
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    // Usually a leftover candidate from a previous connection; safe to ignore.
    console.warn('Ignoring ICE candidate:', err.message);
  }
}

// ---- Signaling --------------------------------------------------------------
function connectSignaling() {
  signaling = new Signaling({ room, role: 'camera' });

  signaling
    .on('joined', (msg) => {
      if (!msg.peerPresent) setStatus('Waiting for a viewer…', 'idle');
    })
    .on('peer-joined', () => startCall().catch((err) => console.error('startCall failed:', err)))
    .on('answer', (msg) => handleAnswer(msg.description).catch((err) => console.error(err)))
    .on('candidate', (msg) => addCandidate(msg.candidate))
    .on('peer-left', () => {
      closePeer();
      setStatus('Viewer left. Waiting for a viewer…', 'idle');
    })
    .on('close', () => setStatus('Lost connection to server. Reconnecting…', 'warn'))
    .on('replaced', () => {
      // This camera room was opened in another tab/device; step aside.
      closePeer();
      for (const track of localStream.getTracks()) track.stop();
      showError('This room was opened as a camera somewhere else, so this page stopped streaming.');
    })
    .on('error', (msg) => console.warn('Server error:', msg.message));
}

// ---- Go ---------------------------------------------------------------------
(async () => {
  if (await startCamera()) {
    await initBattery();
    renderLocalStatus();
    requestWakeLock();
    connectSignaling(); // join only once we have tracks to send
  }
})();
