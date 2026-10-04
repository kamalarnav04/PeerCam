/**
 * stats.js — live connection statistics from WebRTC's built-in getStats().
 *
 * Every second we ask the RTCPeerConnection for its stats report and pull out:
 *   - resolution + frames per second of the video
 *   - bitrate (computed from the byte counter difference since last time)
 *   - round-trip time (network delay there and back)
 *   - packet loss (viewer side) and the codec in use
 *   - the link type: a direct peer-to-peer path, or relayed through TURN
 *
 * Usage:
 *   const stop = startStatsMonitor(pc, 'inbound', (stats) => render(stats));
 *   stop(); // when the connection is closed
 *
 * direction: 'inbound' on the viewer (receiving), 'outbound' on the camera (sending).
 */

export function startStatsMonitor(pc, direction, onUpdate, intervalMs = 1000) {
  let prevBytes = null;
  let prevTimestamp = null;
  let stopped = false;

  async function sample() {
    if (stopped || pc.connectionState === 'closed') return;
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }

    const rtpType = `${direction}-rtp`; // 'inbound-rtp' or 'outbound-rtp'
    let video = null;
    let totalBytes = 0;
    let transport = null;

    report.forEach((s) => {
      if (s.type === rtpType) {
        totalBytes += (direction === 'inbound' ? s.bytesReceived : s.bytesSent) || 0;
        // Outbound may have several "layers" (simulcast); keep the biggest.
        if (s.kind === 'video' && (!video || (s.frameWidth || 0) > (video.frameWidth || 0))) video = s;
      } else if (s.type === 'transport') {
        transport = s;
      }
    });

    // Bitrate = bytes since last sample * 8 / seconds elapsed.
    const now = performance.now();
    let bitrateKbps = null;
    if (prevBytes != null && totalBytes >= prevBytes) {
      bitrateKbps = ((totalBytes - prevBytes) * 8) / (now - prevTimestamp); // bits/ms == kbps
    }
    prevBytes = totalBytes;
    prevTimestamp = now;

    // The candidate pair currently carrying the media.
    let pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
    if (!pair) {
      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
    }
    const local = pair ? report.get(pair.localCandidateId) : null;
    const remote = pair ? report.get(pair.remoteCandidateId) : null;

    // Candidate types: host (LAN address), srflx/prflx (address seen through a
    // NAT), relay (through a TURN server).
    let link = null;
    if (local && remote) {
      link = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN RELAY' : 'P2P DIRECT';
    }

    let lossPct = null;
    if (video && direction === 'inbound' && video.packetsReceived != null) {
      const lost = Math.max(0, video.packetsLost || 0);
      const total = lost + video.packetsReceived;
      lossPct = total > 0 ? (lost / total) * 100 : 0;
    }

    const codec = video?.codecId ? report.get(video.codecId) : null;

    onUpdate({
      width: video?.frameWidth ?? null,
      height: video?.frameHeight ?? null,
      fps: video?.framesPerSecond ?? null,
      bitrateKbps,
      rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      lossPct,
      jitterMs: video?.jitter != null ? video.jitter * 1000 : null,
      codec: codec?.mimeType ? codec.mimeType.split('/')[1] : null,
      link,
      protocol: local?.protocol ? local.protocol.toUpperCase() : null,
    });
  }

  sample();
  const timer = setInterval(sample, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
