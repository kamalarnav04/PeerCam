/**
 * hud.js — small shared helpers for the "command-center" UI.
 *
 *   - formatters (clock, durations, bitrates)
 *   - startClock(): keeps every [data-clock] element showing the current time
 *   - EventLog: the scrolling, timestamped event list on the viewer
 *   - setText(): update an element only when its text actually changes
 */

export const pad2 = (n) => String(n).padStart(2, '0');

/** "14:32:07" */
export function formatTime(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** "2026-10-04 14:32:07" */
export function formatDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(date)}`;
}

/** "20261004-143207", safe for file names. */
export function fileStamp(date = new Date()) {
  return formatDateTime(date).replace(/[-:]/g, '').replace(' ', '-');
}

/** 75 → "01:15", 3725 → "01:02:05" */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = `${pad2(m)}:${pad2(s % 60)}`;
  return h > 0 ? `${pad2(h)}:${rest}` : rest;
}

/** 640 → "640 kbps", 1820 → "1.82 Mbps" */
export function formatBitrate(kbps) {
  if (kbps == null || Number.isNaN(kbps)) return '--';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

/** Only touch the DOM when the value changes (stats update every second). */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Keep all elements with a data-clock attribute showing the current time. */
export function startClock(root = document) {
  const tick = () => {
    const now = formatTime();
    for (const el of root.querySelectorAll('[data-clock]')) setText(el, now);
  };
  tick();
  return setInterval(tick, 1000);
}

/**
 * EventLog — renders events into an <ol>, newest first.
 *   log.add('Motion detected', { level: 'alert', thumb: dataUrl })
 * Levels: info | ok | warn | alert  (styled by CSS via data-level)
 */
export class EventLog {
  constructor(listEl, { max = 100 } = {}) {
    this.listEl = listEl;
    this.max = max;
  }

  add(text, { level = 'info', thumb = null } = {}) {
    const li = document.createElement('li');
    li.dataset.level = level;

    const time = document.createElement('time');
    time.textContent = formatTime();
    const msg = document.createElement('span');
    msg.textContent = text; // textContent, never innerHTML: no HTML injection
    li.append(time, msg);

    if (thumb) {
      const img = document.createElement('img');
      img.src = thumb;
      img.alt = `Snapshot: ${text}`;
      img.loading = 'lazy';
      li.append(img);
    }

    this.listEl.prepend(li);
    while (this.listEl.children.length > this.max) this.listEl.lastElementChild.remove();
  }
}
