/**
 * index.js — landing page "System check".
 *
 * Lists the browser features PeerCam relies on and whether this device has
 * them. The most common problem it catches: opening the page over http://
 * on a phone, which hides the camera API (not a "secure context").
 */

import { startClock } from './hud.js';

startClock();

// [label, ok?, note shown when missing, required?]
const checks = [
  ['Secure context (HTTPS)', window.isSecureContext, 'Open with https:// or the camera is blocked', true],
  ['WebRTC', 'RTCPeerConnection' in window, 'Browser too old for peer-to-peer video', true],
  ['Camera / mic API', Boolean(navigator.mediaDevices?.getUserMedia), 'Needed on the camera device', true],
  ['Recording', 'MediaRecorder' in window, 'Clip recording unavailable', false],
  ['Screen wake lock', 'wakeLock' in navigator, 'Keep the screen on manually', false],
  ['Battery status', 'getBattery' in navigator, 'Battery not reported (normal on iPhone)', false],
  ['Notifications', 'Notification' in window, 'No desktop motion alerts', false],
];

const list = document.getElementById('checks');

function addRow(label, state, note) {
  const li = document.createElement('li');
  li.dataset.state = state; // ok | warn | fail | pending
  const name = document.createElement('span');
  name.textContent = label;
  const result = document.createElement('span');
  result.className = 'check-result';
  result.textContent = { ok: 'OK', warn: 'LIMITED', fail: 'FAIL', pending: '…' }[state];
  li.append(name, result);
  if (note) {
    const small = document.createElement('small');
    small.textContent = note;
    li.append(small);
  }
  list.append(li);
  return li;
}

for (const [label, ok, note, required] of checks) {
  addRow(label, ok ? 'ok' : required ? 'fail' : 'warn', ok ? '' : note);
}

// Last check: can we reach the signaling server's WebSocket?
const serverRow = addRow('Signaling server', 'pending', '');
const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${scheme}//${location.host}/ws`);
const fail = () => {
  serverRow.dataset.state = 'fail';
  serverRow.querySelector('.check-result').textContent = 'OFFLINE';
};
const timeout = setTimeout(() => { fail(); ws.close(); }, 5000);
ws.onopen = () => {
  clearTimeout(timeout);
  serverRow.dataset.state = 'ok';
  serverRow.querySelector('.check-result').textContent = 'ONLINE';
  ws.close();
};
ws.onerror = () => {
  clearTimeout(timeout);
  fail();
};
