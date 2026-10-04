/**
 * config.js — WebRTC network configuration (shared by camera and viewer).
 *
 * ICE servers help two devices find a network path to each other:
 *
 *   STUN: tells a device its own public IP/port as seen from the internet.
 *         Cheap, and enough on the same Wi-Fi and on most home routers.
 *
 *   TURN: a relay server that forwards the media when a direct path is
 *         impossible (common on mobile networks / strict NATs). Needed for
 *         reliable internet use, but it costs bandwidth, so it's phase 2.
 */

export const ICE_SERVERS = [
  // Google's free public STUN server.
  { urls: 'stun:stun.l.google.com:19302' },

  // ---------------------------------------------------------------------------
  // TODO (Phase 2): add a TURN server here for viewing over the internet /
  // mobile data. Example shape (e.g. a self-hosted coturn or a TURN provider):
  //
  // {
  //   urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
  //   username: 'USERNAME',
  //   credential: 'PASSWORD',
  // },
  //
  // Don't ship long-lived TURN passwords in a public page — in phase 2 we'll
  // have the server hand out short-lived credentials instead.
  // ---------------------------------------------------------------------------
];
