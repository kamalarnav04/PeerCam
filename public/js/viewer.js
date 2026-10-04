/**
 * viewer.js — the monitoring console (your laptop).
 *
 * Flow:
 *   1. Get the room code from ?room= in the URL. Submitting the form just
 *      reloads the page with ?room=CODE, so a reload always rejoins.
 *   2. Connect to the signaling server as role "viewer".
 *   3. When the camera sends an OFFER, build a fresh RTCPeerConnection,
 *      reply with an ANSWER, trade ICE candidates, and show the incoming
 *      stream in the <video> element.
 *
 * Features layered on top:
 *   - live link stats (stats.js)            - snapshot / clip recording (media.js)
 *   - motion detection + alerts (motion.js) - hold-to-talk two-way audio
 *   - camera device status, received over a WebRTC data channel
 *   - event log + keyboard shortcuts
 */

import { ICE_SERVERS } from './config.js';
import { Signaling, normalizeRoomCode, isValidRoomCode } from './signaling.js';
import { startStatsMonitor } from './stats.js';
import { MotionDetector } from './motion.js';
import { ClipRecorder, takeSnapshot, downloadBlob, videoThumbnail } from './media.js';
import { startClock, setText, EventLog, formatDuration, formatBitrate, formatTime, fileStamp } from './hud.js';

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $('join-form');
const roomInput = $('room-input');
const formError = $('form-error');
const joinSection = $('join');
const watchSection = $('watch');
const feed = $('feed');
const remoteVideo = $('remote');
const overlay = $('motion-overlay');
const placeholder = $('placeholder');
const placeholderSub = $('placeholder-sub');
const linkState = $('link-state');
const statusEl = $('status');
const badges = { live: $('live-badge'), rec: $('rec-badge'), talk: $('talk-badge'), motion: $('motion-badge') };
const buttons = {
  snapshot: $('snapshot'),
  record: $('record'),
  talk: $('talk'),
  unmute: $('unmute'),
  fullscreen: $('fullscreen'),
};
const stat = {
  link: $('st-link'), rtt: $('st-rtt'), bitrate: $('st-bitrate'), video: $('st-video'),
  loss: $('st-loss'), codec: $('st-codec'), hud: $('hud-stats'),
};
const dev = {
  battery: $('dev-battery'), batteryBar: $('dev-battery-bar'), uptime: $('dev-uptime'),
  network: $('dev-network'), device: $('dev-device'), sensor: $('dev-sensor'), wake: $('dev-wake'),
};
const motionUi = {
  arm: $('motion-arm'), armLabel: $('motion-arm-label'), meter: $('motion-meter'), mark: $('motion-mark'),
  level: $('motion-level'), trigger: $('motion-trigger'), sensitivity: $('sensitivity'),
  sensitivityValue: $('sensitivity-value'), sound: $('motion-sound'), notify: $('motion-notify'),
};

startClock();
const log = new EventLog($('log'));

/** Set a button's visible label (keeps its <kbd> shortcut hint). */
const setLabel = (btn, text) => setText(btn.querySelector('.btn-label'), text);

// ---- Small persistent preferences (this browser only) ------------------------
// localStorage can throw (private mode, blocked storage), so always wrap it.
function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`peercam.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(`peercam.${key}`, JSON.stringify(value));
  } catch {
    /* not important */
  }
}

// ---- State ------------------------------------------------------------------
let room = null;
let signaling = null;
let pc = null;
let dataChannel = null;
let stopStats = null;
let pendingCandidates = []; // ICE candidates that arrived before the offer was applied
let linkLogged = false;

let cameraStatus = null; // last status message from the camera
let cameraStatusAt = 0;
let lowBatteryWarned = false;

/** Status text in the Link panel + the pill in the top bar. */
function setStatus(text, state = 'wait') {
  setText(statusEl, text);
  setText(placeholderSub, text);
  const pill = { idle: 'IDLE', wait: 'CONNECTING', ok: 'LIVE', warn: 'UNSTABLE', error: 'NO SIGNAL' }[state];
  setText(linkState, pill);
  linkState.dataset.state = state;
}

function isLive() {
  return Boolean(remoteVideo.srcObject && remoteVideo.videoWidth && pc?.connectionState === 'connected');
}

function setLive(live) {
  badges.live.hidden = !live;
  placeholder.hidden = live;
  buttons.snapshot.disabled = !live;
  buttons.record.disabled = !live && !recorder.recording;
  buttons.talk.disabled = !live;
}

// Make the feed box match the camera's aspect ratio (landscape or portrait
// phone), so the motion overlay lines up exactly with the picture.
function fitFeed() {
  if (remoteVideo.videoWidth && remoteVideo.videoHeight) {
    feed.style.setProperty('--ar', (remoteVideo.videoWidth / remoteVideo.videoHeight).toFixed(4));
  }
}
remoteVideo.addEventListener('loadedmetadata', fitFeed);
remoteVideo.addEventListener('resize', fitFeed);

// ---- Step 1: room form + recent rooms ---------------------------------------
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeRoomCode(roomInput.value);
  if (!isValidRoomCode(code)) {
    formError.textContent = 'Access codes are 4–8 letters/numbers, e.g. K7PX2M.';
    formError.hidden = false;
    return;
  }
  // Reload with the code in the URL. Simple, and makes reloads rejoin for free.
  location.search = `?room=${code}`;
});

function renderRecentRooms() {
  const recent = loadPref('recentRooms', []).filter(isValidRoomCode);
  if (!recent.length) return;
  const box = $('recent');
  for (const code of recent) {
    const a = document.createElement('a');
    a.className = 'chip';
    a.href = `?room=${code}`;
    a.textContent = code;
    box.append(a);
  }
  box.hidden = false;
}

function rememberRoom(code) {
  const recent = loadPref('recentRooms', []).filter((c) => c !== code);
  savePref('recentRooms', [code, ...recent].slice(0, 5));
}

// ---- Audio + fullscreen controls ---------------------------------------------
// Browsers block autoplay WITH sound until the user interacts with the page,
// so the video starts muted and this button turns the sound on.
let ducked = false; // true while talking (incoming audio temporarily muted)
let mutedBeforeTalk = true;

function syncAudioButton() {
  const muted = ducked ? mutedBeforeTalk : remoteVideo.muted;
  setLabel(buttons.unmute, muted ? 'Unmute audio' : 'Mute audio');
  buttons.unmute.classList.toggle('active', !muted);
}

function toggleAudio() {
  if (ducked) {
    mutedBeforeTalk = !mutedBeforeTalk; // applied when talking ends
  } else {
    remoteVideo.muted = !remoteVideo.muted;
    remoteVideo.play().catch(() => {});
  }
  syncAudioButton();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (feed.requestFullscreen) feed.requestFullscreen(); // feed = video + HUD overlay
  else if (remoteVideo.webkitEnterFullscreen) remoteVideo.webkitEnterFullscreen(); // iPhone Safari
}

buttons.unmute.addEventListener('click', toggleAudio);
buttons.fullscreen.addEventListener('click', toggleFullscreen);
feed.addEventListener('dblclick', toggleFullscreen);

// ---- Snapshot + recording ---------------------------------------------------
const recorder = new ClipRecorder();
let recTimer = null;

function flashFeed(kind) {
  feed.classList.remove('flash-snap', 'flash-motion');
  void feed.offsetWidth; // restart the CSS animation
  feed.classList.add(`flash-${kind}`);
}

async function snapshot() {
  if (!isLive()) return;
  try {
    const blob = await takeSnapshot(remoteVideo, `PEERCAM // ${room}`);
    const name = `peercam-${room}-${fileStamp()}.png`;
    downloadBlob(blob, name);
    flashFeed('snap');
    log.add(`Snapshot saved: ${name}`, { level: 'ok', thumb: videoThumbnail(remoteVideo) });
  } catch (err) {
    log.add(`Snapshot failed: ${err.message}`, { level: 'warn' });
  }
}

function startRecording() {
  if (!isLive()) return;
  if (!ClipRecorder.supported) {
    log.add('Recording is not supported in this browser', { level: 'warn' });
    return;
  }
  try {
    recorder.start(remoteVideo.srcObject);
  } catch (err) {
    log.add(`Recording failed: ${err.message}`, { level: 'warn' });
    return;
  }
  badges.rec.hidden = false;
  buttons.record.classList.add('active');
  setLabel(buttons.record, 'Stop rec');
  setText($('rec-time'), '00:00');
  recTimer = setInterval(() => setText($('rec-time'), formatDuration(recorder.elapsedMs / 1000)), 500);
  log.add('Recording started', { level: 'info' });
}

async function stopRecording(reason = 'Clip saved') {
  if (!recorder.recording) return;
  clearInterval(recTimer);
  badges.rec.hidden = true;
  buttons.record.classList.remove('active');
  setLabel(buttons.record, 'Record');
  const result = await recorder.stop();
  buttons.record.disabled = !isLive();
  if (!result || !result.blob.size) return;
  const name = `peercam-${room}-${fileStamp()}.${result.extension}`;
  downloadBlob(result.blob, name);
  const mb = (result.blob.size / (1024 * 1024)).toFixed(1);
  log.add(`${reason}: ${name} (${formatDuration(result.durationMs / 1000)}, ${mb} MB)`, { level: 'ok' });
}

buttons.snapshot.addEventListener('click', snapshot);
buttons.record.addEventListener('click', () => (recorder.recording ? stopRecording() : startRecording()));

// ---- Two-way talk (hold to talk) ---------------------------------------------
// Our microphone goes out on the audio transceiver the camera's offer created
// (it is two-way). We attach the mic once and just enable/disable the track,
// so pressing talk is instant and needs no renegotiation.
let micStream = null;
let talking = false;

function audioTransceiver(peer) {
  return peer?.getTransceivers().find((t) => t.receiver.track?.kind === 'audio') || null;
}

async function attachMic(peer) {
  const transceiver = audioTransceiver(peer);
  const mic = micStream?.getAudioTracks()[0];
  if (transceiver && mic) await transceiver.sender.replaceTrack(mic);
}

function sendControl(msg) {
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify(msg));
}

async function startTalk() {
  if (talking || !isLive()) return;
  talking = true;
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStream.getAudioTracks()[0].enabled = false;
      await attachMic(pc);
      log.add('Microphone ready for talk-back', { level: 'ok' });
    } catch (err) {
      talking = false;
      log.add(`Microphone unavailable: ${err.message}`, { level: 'warn' });
      return;
    }
  }
  if (!talking) return; // button released while the permission prompt was open

  micStream.getAudioTracks()[0].enabled = true;
  // Walkie-talkie style: silence the camera's audio while we talk, so our
  // own voice doesn't echo back through the phone's microphone.
  mutedBeforeTalk = remoteVideo.muted;
  remoteVideo.muted = true;
  ducked = true;
  sendControl({ type: 'talk', active: true });
  badges.talk.hidden = false;
  buttons.talk.classList.add('active');
  setLabel(buttons.talk, 'Talking…');
}

function stopTalk() {
  if (!talking) return;
  talking = false;
  const mic = micStream?.getAudioTracks()[0];
  if (mic) mic.enabled = false;
  if (ducked) {
    remoteVideo.muted = mutedBeforeTalk;
    ducked = false;
  }
  sendControl({ type: 'talk', active: false });
  badges.talk.hidden = true;
  buttons.talk.classList.remove('active');
  setLabel(buttons.talk, 'Hold to talk');
  syncAudioButton();
}

buttons.talk.addEventListener('pointerdown', (e) => {
  // Capture the pointer so releasing outside the button still stops talking.
  try {
    buttons.talk.setPointerCapture(e.pointerId);
  } catch {
    /* some synthetic/stylus pointers can't be captured; talking still works */
  }
  startTalk();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  buttons.talk.addEventListener(type, stopTalk);
}
buttons.talk.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on touch
window.addEventListener('blur', stopTalk); // never leave the mic open by accident

// ---- Motion detection -------------------------------------------------------
let audioCtx = null;

/** Audio can only start after a user gesture; call this from click handlers. */
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AC) audioCtx = new AC();
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });

/** Two short alarm tones generated with the Web Audio API (no sound files). */
function beep() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  [[0, 880], [0.18, 660]].forEach(([delay, freq]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.12, t + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.15);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.16);
  });
}

// The meter shows 0–20 % of pixels changed across its full width.
const METER_SCALE = 5;

function renderMotionLevel(level, trigger) {
  motionUi.meter.style.width = `${Math.min(100, level * METER_SCALE)}%`;
  motionUi.meter.dataset.hot = level >= trigger ? 'true' : 'false';
  motionUi.mark.style.left = `${Math.min(100, trigger * METER_SCALE)}%`;
  setText(motionUi.level, `${level.toFixed(1)}%`);
  setText(motionUi.trigger, `${trigger.toFixed(1)}%`);
}

let motionBadgeTimer = null;
const baseTitle = document.title;

function handleMotion({ level, thumbnail }) {
  log.add(`Motion detected · ${level.toFixed(1)}% of frame changed`, { level: 'alert', thumb: thumbnail });
  flashFeed('motion');
  badges.motion.hidden = false;
  clearTimeout(motionBadgeTimer);
  motionBadgeTimer = setTimeout(() => (badges.motion.hidden = true), 4000);

  if (motionUi.sound.checked) beep();
  if (document.hidden) {
    document.title = `⚠ MOTION · ${baseTitle}`;
    if (motionUi.notify.checked && window.Notification?.permission === 'granted') {
      new Notification('PeerCam: motion detected', {
        body: `Camera ${room} · ${formatTime()}`,
        tag: 'peercam-motion', // replaces the previous one instead of stacking
      });
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = room ? `Monitor ${room} · PeerCam` : baseTitle;
});

const motion = new MotionDetector(remoteVideo, overlay, {
  onLevel: renderMotionLevel,
  onMotion: handleMotion,
});

function setArmed(armed, { quiet = false } = {}) {
  motionUi.arm.checked = armed;
  overlay.hidden = !armed;
  setText(motionUi.armLabel, armed ? 'Armed' : 'Disarmed');
  motionUi.arm.closest('.switch').dataset.on = String(armed);
  if (armed) motion.start();
  else motion.stop();
  savePref('motionArmed', armed);
  if (!quiet) log.add(armed ? 'Motion detection armed' : 'Motion detection disarmed', { level: armed ? 'ok' : 'info' });
}

function setSensitivity(value) {
  motion.sensitivity = value;
  motionUi.sensitivity.value = value;
  setText(motionUi.sensitivityValue, String(value));
  renderMotionLevel(0, motion.triggerLevel);
  savePref('motionSensitivity', value);
}

motionUi.arm.addEventListener('change', () => {
  unlockAudio();
  setArmed(motionUi.arm.checked);
});
motionUi.sensitivity.addEventListener('input', () => setSensitivity(Number(motionUi.sensitivity.value)));
motionUi.sound.addEventListener('change', () => {
  unlockAudio();
  savePref('motionSound', motionUi.sound.checked);
});
motionUi.notify.addEventListener('change', async () => {
  savePref('motionNotify', motionUi.notify.checked);
  if (!motionUi.notify.checked) return;
  if (!window.Notification) {
    motionUi.notify.checked = false;
    log.add('Desktop notifications are not supported in this browser', { level: 'warn' });
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    motionUi.notify.checked = false;
    savePref('motionNotify', false);
    log.add('Notification permission was not granted', { level: 'warn' });
  }
});

// ---- Camera device status (data channel) --------------------------------------
function handleControlMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.type === 'status') {
    cameraStatus = msg;
    cameraStatusAt = Date.now();
    renderDevice();
  }
}

function renderDevice() {
  const s = cameraStatus;
  if (!s) {
    for (const key of ['battery', 'uptime', 'network', 'device', 'sensor', 'wake']) setText(dev[key], '--');
    dev.batteryBar.style.width = '0%';
    delete dev.wake.dataset.state;
    return;
  }
  // The camera sends uptime every 5 s; count up locally in between.
  setText(dev.uptime, formatDuration(s.uptime + (Date.now() - cameraStatusAt) / 1000));

  if (s.battery) {
    const pct = Math.round(s.battery.level * 100);
    setText(dev.battery, `${pct}%${s.battery.charging ? ' ⚡ CHARGING' : ''}`);
    dev.batteryBar.style.width = `${pct}%`;
    const low = pct <= 20 && !s.battery.charging;
    dev.batteryBar.dataset.state = low ? 'low' : 'ok';
    if (low && !lowBatteryWarned) {
      lowBatteryWarned = true;
      log.add(`Camera battery low (${pct}%) and not charging`, { level: 'warn' });
    }
    if (!low) lowBatteryWarned = false;
  } else {
    setText(dev.battery, 'N/A');
    dev.batteryBar.style.width = '0%';
  }
  // network = actual connection type (Android Chrome: WIFI / CELLULAR);
  // netSpeed = the browser's speed class estimate (e.g. "4g"), as a fallback.
  setText(dev.network, s.network ? s.network.toUpperCase() : s.netSpeed ? `~${s.netSpeed.toUpperCase()} SPEED` : 'N/A');
  setText(dev.device, s.device || 'N/A');
  setText(dev.sensor, s.video ? `${s.video.width}×${s.video.height}${s.video.facing ? ` · ${s.video.facing === 'environment' ? 'REAR' : 'FRONT'}` : ''}` : '--');
  setText(dev.wake, s.wakeLock ? 'KEPT AWAKE' : 'MAY SLEEP');
  dev.wake.dataset.state = s.wakeLock ? 'ok' : 'warn';
}
setInterval(renderDevice, 1000);

// ---- Link stats -------------------------------------------------------------
function renderStats(s) {
  setText(stat.link, s.link ? `${s.link}${s.protocol ? ` · ${s.protocol}` : ''}` : 'NEGOTIATING');
  setText(stat.rtt, s.rttMs != null ? `${Math.round(s.rttMs)} ms` : '--');
  setText(stat.bitrate, formatBitrate(s.bitrateKbps));
  setText(stat.video, s.width ? `${s.width}×${s.height} · ${Math.round(s.fps || 0)} fps` : '--');
  setText(stat.loss, s.lossPct != null ? `${s.lossPct.toFixed(1)}%` : '--');
  setText(stat.codec, s.codec ? s.codec.toUpperCase() : '--');
  setText(stat.hud, s.width ? `${s.height}p · ${Math.round(s.fps || 0)}FPS · ${formatBitrate(s.bitrateKbps)}` : '--');

  if (s.link && !linkLogged) {
    linkLogged = true;
    log.add(`Link established: ${s.link}${s.rttMs != null ? `, ${Math.round(s.rttMs)} ms` : ''}`, { level: 'ok' });
  }
}

function resetStats() {
  for (const key of Object.keys(stat)) setText(stat[key], '--');
}

// ---- WebRTC -----------------------------------------------------------------
function closePeer() {
  if (recorder.recording) stopRecording('Clip saved (stream ended)');
  stopTalk();
  if (stopStats) stopStats();
  stopStats = null;
  if (dataChannel) dataChannel.onmessage = null;
  dataChannel = null;
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    pc.close();
  }
  pc = null;
  pendingCandidates = [];
  linkLogged = false;
  cameraStatus = null;
  remoteVideo.srcObject = null;
  setLive(false);
  resetStats();
  renderDevice();
}

/** The camera always makes the offer; we answer it with a brand-new connection. */
async function handleOffer(description) {
  closePeer();

  const thisPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc = thisPc;

  // The camera's audio + video tracks arrive here.
  thisPc.ontrack = (event) => {
    if (event.streams[0] && remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(() => {}); // muted autoplay is always allowed
    }
  };

  // The camera's control channel (device status in, talk state out).
  thisPc.ondatachannel = (event) => {
    if (pc !== thisPc) return;
    dataChannel = event.channel;
    dataChannel.onmessage = handleControlMessage;
  };

  thisPc.onicecandidate = (event) => {
    if (event.candidate) signaling.send({ type: 'candidate', candidate: event.candidate });
  };

  thisPc.onconnectionstatechange = () => {
    const state = thisPc.connectionState;
    if (state === 'connected') {
      setStatus('Live', 'ok');
      // The video may need a moment to produce its first frame.
      const markLive = () => setLive(isLive());
      if (remoteVideo.videoWidth) markLive();
      else remoteVideo.addEventListener('loadeddata', markLive, { once: true });
      if (!stopStats) stopStats = startStatsMonitor(thisPc, 'inbound', renderStats);
      log.add('Video stream live', { level: 'ok' });
    } else if (state === 'connecting') {
      setStatus('Connecting to camera…', 'wait');
    } else if (state === 'disconnected') {
      setStatus('Connection interrupted. Trying to recover…', 'warn');
    } else if (state === 'failed') {
      setStatus('Connection failed. Waiting for the camera to reconnect…', 'error');
      setLive(false);
      log.add('Connection failed', { level: 'warn' });
    }
  };

  setStatus('Connecting to camera…', 'wait');
  await thisPc.setRemoteDescription(description);
  if (pc !== thisPc) return; // a newer offer arrived meanwhile

  // Make the audio line two-way so we can talk back, and re-attach the mic
  // if it was already set up during an earlier connection.
  const audio = audioTransceiver(thisPc);
  if (audio) audio.direction = 'sendrecv';
  await attachMic(thisPc);

  for (const candidate of pendingCandidates) await addCandidate(candidate);
  pendingCandidates = [];

  const answer = await thisPc.createAnswer();
  if (pc !== thisPc) return;
  await thisPc.setLocalDescription(answer);
  signaling.send({ type: 'answer', description: thisPc.localDescription });
}

async function addCandidate(candidate) {
  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(candidate); // the offer is still being applied
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('Ignoring ICE candidate:', err.message); // usually from an old connection
  }
}

// ---- Signaling --------------------------------------------------------------
function watch(code) {
  room = code;
  rememberRoom(room);
  joinSection.hidden = true;
  watchSection.hidden = false;
  setText($('room-label'), room);
  document.title = `Monitor ${room} · PeerCam`;
  setStatus('Connecting to server…', 'wait');
  log.add(`Opening uplink to room ${room}`);

  signaling = new Signaling({ room, role: 'viewer' });

  signaling
    .on('joined', (msg) => {
      if (msg.peerPresent) {
        setStatus('Camera found. Connecting…', 'wait');
      } else {
        setStatus('Waiting for the camera to come online…', 'idle');
        log.add('Joined room; waiting for the camera');
      }
    })
    .on('peer-joined', () => {
      setStatus('Camera online. Connecting…', 'wait'); // camera will send an offer
      log.add('Camera online', { level: 'ok' });
    })
    .on('offer', (msg) =>
      handleOffer(msg.description).catch((err) => {
        console.error('handleOffer failed:', err);
        setStatus('Could not connect to the camera. Waiting for it to retry…', 'error');
      })
    )
    .on('candidate', (msg) => addCandidate(msg.candidate))
    .on('peer-left', () => {
      closePeer();
      setStatus('Camera disconnected. Waiting for it to come back…', 'error');
      log.add('Camera disconnected', { level: 'warn' });
    })
    .on('close', () => {
      setStatus('Lost connection to server. Reconnecting…', 'warn');
      log.add('Signaling server unreachable; retrying', { level: 'warn' });
    })
    .on('replaced', () => {
      closePeer();
      setStatus('This camera is now being watched in another tab or device. Reload to watch here.', 'error');
      log.add('Another monitor took over this room', { level: 'warn' });
    })
    .on('error', (msg) => console.warn('Server error:', msg.message));
}

// ---- Keyboard shortcuts -------------------------------------------------------
//   S snapshot · R record · Space hold-to-talk · M audio · F fullscreen · D arm motion
document.addEventListener('keydown', (e) => {
  if (watchSection.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select')) return;
  const key = e.key.toLowerCase();
  if (key === ' ') {
    e.preventDefault(); // don't scroll / press the focused button
    if (!e.repeat) startTalk();
    return;
  }
  if (e.repeat) return;
  if (key === 's') snapshot();
  else if (key === 'r') buttons.record.click();
  else if (key === 'm') toggleAudio();
  else if (key === 'f') toggleFullscreen();
  else if (key === 'd') {
    unlockAudio();
    setArmed(!motionUi.arm.checked);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && !watchSection.hidden) {
    e.preventDefault();
    stopTalk();
  }
});

// ---- Go ---------------------------------------------------------------------
motionUi.sound.checked = loadPref('motionSound', true);
motionUi.notify.checked = loadPref('motionNotify', false) && window.Notification?.permission === 'granted';
setSensitivity(Number(loadPref('motionSensitivity', 50)) || 50);
syncAudioButton();
resetStats();
renderDevice();

const roomFromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
if (isValidRoomCode(roomFromUrl)) {
  watch(roomFromUrl);
  if (loadPref('motionArmed', false)) {
    setArmed(true, { quiet: true });
    log.add('Motion detection armed (restored)', { level: 'ok' });
  }
} else {
  renderRecentRooms();
  roomInput.focus();
}
