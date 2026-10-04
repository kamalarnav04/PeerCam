/**
 * media.js — save what the viewer sees: snapshots (PNG) and clips (video file).
 *
 * Everything happens in the browser and is saved to your Downloads folder.
 * Nothing is uploaded or stored on the server.
 */

import { formatDateTime } from './hud.js';

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A small JPEG (data: URL) of the current video frame, for the event log. */
export function videoThumbnail(video, width = 240) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((width * video.videoHeight) / video.videoWidth) || Math.round(width * 0.5625);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

/**
 * Grab the current video frame at full resolution, with a timestamp band
 * burned into the bottom (like a real CCTV still). Resolves to a PNG Blob.
 */
export function takeSnapshot(video, label) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(video, 0, 0);

  const fontSize = Math.max(14, Math.round(c.height / 32));
  const band = Math.round(fontSize * 1.8);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, c.height - band, c.width, band);
  ctx.font = `${fontSize}px ui-monospace, Consolas, monospace`;
  ctx.fillStyle = '#00e5ff';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${label}  ${formatDateTime()}`, fontSize, c.height - band / 2);

  return new Promise((resolve, reject) => {
    c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Snapshot failed'))), 'image/png');
  });
}

/** First recording format this browser supports (Chrome/Edge/Firefox: WebM, Safari: MP4). */
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
  ];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * ClipRecorder — records a MediaStream (video + audio) with MediaRecorder.
 *   const rec = new ClipRecorder();
 *   rec.start(stream);
 *   const { blob, extension, durationMs } = await rec.stop();
 */
export class ClipRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  static get supported() {
    return typeof window.MediaRecorder === 'function';
  }

  get recording() {
    return this.recorder?.state === 'recording';
  }

  get elapsedMs() {
    return this.recording ? Date.now() - this.startedAt : 0;
  }

  start(stream) {
    const mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(1000); // emit a chunk every second, so little is lost if the stream drops
    this.startedAt = Date.now();
  }

  stop() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    const durationMs = Date.now() - this.startedAt;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        resolve({ blob, durationMs, extension: type.includes('mp4') ? 'mp4' : 'webm' });
      };
      recorder.stop();
    });
  }
}
