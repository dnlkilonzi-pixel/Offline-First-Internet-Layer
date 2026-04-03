'use strict';

/**
 * discovery.js – UDP-broadcast peer discovery.
 *
 * Each node periodically broadcasts a HELLO datagram on a shared UDP port.
 * When another node receives a HELLO it adds the sender to its peer list.
 * Stale peers (not seen for TTL ms) are automatically pruned.
 *
 * Events emitted:
 *   'peer:new'     (peer)  – a previously-unknown peer was discovered
 *   'peer:lost'    (peer)  – a known peer has not been seen for TTL ms
 */

const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

const DEFAULT_PORT = 41234;
const DEFAULT_BROADCAST_INTERVAL_MS = 5_000;
const DEFAULT_TTL_MS = 20_000;
const PROTOCOL_TAG = 'OFIL_HELLO';

/** Return the first non-loopback IPv4 address found on this machine. */
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

class Discovery extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.nodeId]          – Unique identifier for this node.
   * @param {number} [opts.port]            – UDP port to use (default 41234).
   * @param {number} [opts.broadcastInterval] – ms between HELLO broadcasts.
   * @param {number} [opts.ttl]             – ms before a silent peer is dropped.
   */
  constructor(opts = {}) {
    super();
    this._nodeId = opts.nodeId || require('crypto').randomUUID();
    this._port = opts.port || DEFAULT_PORT;
    this._broadcastInterval = opts.broadcastInterval || DEFAULT_BROADCAST_INTERVAL_MS;
    this._ttl = opts.ttl || DEFAULT_TTL_MS;
    this._localIp = getLocalIp();
    this._peers = new Map(); // nodeId -> { nodeId, ip, apiPort, lastSeen }
    this._socket = null;
    this._broadcastTimer = null;
    this._pruneTimer = null;
  }

  /** The peer list (copy). */
  get peers() {
    return Array.from(this._peers.values());
  }

  /** This node's unique identifier. */
  get nodeId() {
    return this._nodeId;
  }

  /**
   * Start broadcasting and listening.
   * @param {number} [apiPort] – The HTTP API port this node exposes.
   */
  start(apiPort = 3000) {
    this._apiPort = apiPort;
    this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this._socket.on('error', (err) => {
      this.emit('error', err);
    });

    this._socket.on('message', (msg, rinfo) => {
      this._onMessage(msg.toString(), rinfo);
    });

    this._socket.bind(this._port, () => {
      try {
        this._socket.setBroadcast(true);
      } catch (_) {
        // Non-fatal – some environments don't support broadcast.
      }
      this._scheduleBroadcast();
      this._schedulePrune();
    });
  }

  /** Stop all timers and close the socket. */
  stop() {
    clearInterval(this._broadcastTimer);
    clearInterval(this._pruneTimer);
    if (this._socket) {
      try { this._socket.close(); } catch (_) { /* ignore */ }
      this._socket = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _buildHello() {
    return JSON.stringify({
      tag: PROTOCOL_TAG,
      nodeId: this._nodeId,
      ip: this._localIp,
      apiPort: this._apiPort,
    });
  }

  _broadcast() {
    if (!this._socket) return;
    const msg = Buffer.from(this._buildHello());
    this._socket.send(msg, 0, msg.length, this._port, '255.255.255.255', (err) => {
      if (err) this.emit('error', err);
    });
  }

  _scheduleBroadcast() {
    this._broadcast(); // immediate first broadcast
    this._broadcastTimer = setInterval(() => this._broadcast(), this._broadcastInterval);
  }

  _schedulePrune() {
    this._pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, peer] of this._peers) {
        if (now - peer.lastSeen > this._ttl) {
          this._peers.delete(id);
          this.emit('peer:lost', peer);
        }
      }
    }, this._ttl / 2);
  }

  _onMessage(raw, rinfo) {
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (data.tag !== PROTOCOL_TAG) return;
    if (data.nodeId === this._nodeId) return; // own broadcast

    const isNew = !this._peers.has(data.nodeId);
    const peer = {
      nodeId: data.nodeId,
      ip: data.ip || rinfo.address,
      apiPort: data.apiPort || 3000,
      lastSeen: Date.now(),
    };
    this._peers.set(data.nodeId, peer);
    if (isNew) {
      this.emit('peer:new', peer);
    }
  }
}

module.exports = Discovery;
