/**
 * motion.js — simple, fast motion detection in the browser (no libraries).
 *
 * How it works (frame differencing):
 *   1. A few times per second, draw the current video frame onto a tiny
 *      hidden canvas (160 px wide). Small = fast, and it ignores sensor noise.
 *   2. Convert every pixel to a brightness value (grayscale).
 *   3. Compare with the previous frame: a pixel "changed" if its brightness
 *      moved by more than PIXEL_DELTA.
 *   4. level = % of pixels that changed. If it stays above the trigger
 *      threshold for 2 frames in a row, that's motion.
 *
 * The changed pixels are painted red on an overlay canvas on top of the video,
 * so you can see *where* the movement is.
 *
 * Usage:
 *   const md = new MotionDetector(videoEl, overlayCanvas, {
 *     onLevel: (level, triggerLevel) => ...,   // every analyzed frame
 *     onMotion: ({ level, thumbnail }) => ..., // when motion is detected
 *   });
 *   md.sensitivity = 60; // 1..100
 *   md.start(); md.stop();
 */

import { videoThumbnail } from './media.js';

const ANALYSIS_WIDTH = 160;
const PIXEL_DELTA = 28; // brightness change (0-255) that counts as "changed"
const INTERVAL_MS = 200; // 5 analyses per second
const CONSECUTIVE_FRAMES = 2; // ignore single-frame flickers
const COOLDOWN_MS = 8000; // at most one motion event per 8 s

export class MotionDetector {
  constructor(video, overlay, { onLevel = () => {}, onMotion = () => {} } = {}) {
    this.video = video;
    this.overlay = overlay;
    this.onLevel = onLevel;
    this.onMotion = onMotion;
    this.sensitivity = 50;

    this.work = document.createElement('canvas'); // hidden analysis canvas
    this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    this.overlayCtx = overlay.getContext('2d');

    this.prev = null; // previous frame's grayscale values
    this.timer = null;
    this.hits = 0;
    this.lastEventAt = 0;
  }

  /** % of changed pixels needed to trigger. Sensitivity 100 → 0.2 %, 50 → 5.2 %, 1 → 10.1 %. */
  get triggerLevel() {
    return 0.2 + (100 - this.sensitivity) * 0.1;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.running) return;
    this.prev = null;
    this.hits = 0;
    this.timer = setInterval(() => this.analyze(), INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.prev = null;
    this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.onLevel(0, this.triggerLevel);
  }

  analyze() {
    const { video } = this;
    if (video.readyState < 2 || !video.videoWidth) {
      if (this.prev) {
        // Picture just went away: clear the overlay and the meter.
        this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        this.onLevel(0, this.triggerLevel);
      }
      this.prev = null;
      this.hits = 0;
      return;
    }

    const w = ANALYSIS_WIDTH;
    const h = Math.max(1, Math.round((ANALYSIS_WIDTH * video.videoHeight) / video.videoWidth));
    if (this.work.width !== w || this.work.height !== h) {
      // Resolution/orientation changed: start over.
      this.work.width = this.overlay.width = w;
      this.work.height = this.overlay.height = h;
      this.prev = null;
    }

    this.workCtx.drawImage(video, 0, 0, w, h);
    const pixels = this.workCtx.getImageData(0, 0, w, h).data; // RGBA bytes
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      // Standard luminance weights: the eye is most sensitive to green.
      gray[i] = (pixels[p] * 77 + pixels[p + 1] * 150 + pixels[p + 2] * 29) >> 8;
    }

    if (this.prev) {
      const heat = this.overlayCtx.createImageData(w, h);
      let changed = 0;
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - this.prev[i]) > PIXEL_DELTA) {
          changed++;
          const p = i * 4;
          heat.data[p] = 255; // red
          heat.data[p + 1] = 46;
          heat.data[p + 2] = 77;
          heat.data[p + 3] = 150; // semi-transparent
        }
      }
      this.overlayCtx.putImageData(heat, 0, 0);

      const level = (changed / gray.length) * 100;
      const trigger = this.triggerLevel;
      this.onLevel(level, trigger);

      this.hits = level >= trigger ? this.hits + 1 : 0;
      const now = Date.now();
      if (this.hits >= CONSECUTIVE_FRAMES && now - this.lastEventAt > COOLDOWN_MS) {
        this.lastEventAt = now;
        this.onMotion({ level, thumbnail: videoThumbnail(video) });
      }
    }
    this.prev = gray;
  }
}
