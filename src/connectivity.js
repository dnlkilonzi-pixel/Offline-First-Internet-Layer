'use strict';

/**
 * connectivity.js – Multi-tier connectivity monitor.
 *
 * Connectivity tiers (ascending capability):
 *
 *   NONE     – No peers visible, no internet.
 *   LAN      – At least one peer is reachable on the local network.
 *   HOTSPOT  – A local gateway responds (limited outbound WAN, e.g. mobile hotspot).
 *   WAN      – Full internet confirmed (public DNS resolver reachable).
 *
 * The monitor probes each tier on a configurable interval and emits
 * 'tier:change' whenever the highest available tier changes.
 *
 * Callers map tiers to sync strategies:
 *   WAN     → push unsynced messages to the remote endpoint immediately.
 *   HOTSPOT → schedule a delayed batch push (opportunistic / DTN-style).
 *   LAN     → local gossip is already running; no remote push needed.
 *   NONE    → queue locally; wait for any tier to appear.
 *
 * Events emitted:
 *   'tier:change'  (tier, prevTier)  – Connectivity tier changed.
 */

const net = require('net');
const EventEmitter = require('events');

const TIERS = Object.freeze({
  NONE: 'none',
  LAN: 'lan',
  HOTSPOT: 'hotspot',
  WAN: 'wan',
});

const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// WAN probe: well-known public DNS resolver (Google)
const DEFAULT_WAN_HOST = '8.8.8.8';
const DEFAULT_WAN_PORT = 53;

// Hotspot probe: try common residential/mobile gateway addresses
const DEFAULT_HOTSPOT_HOSTS = ['192.168.1.1', '10.0.0.1', '172.16.0.1'];
const DEFAULT_HOTSPOT_PORT = 80;

class ConnectivityMonitor extends EventEmitter {
  /**
   * @param {object} discovery – Discovery instance (used to determine LAN tier).
   * @param {object} [opts]
   * @param {number} [opts.checkInterval]  – ms between connectivity checks.
   * @param {number} [opts.probeTimeout]   – ms before a TCP probe times out.
   * @param {string} [opts.wanHost]        – Host to probe for WAN.
   * @param {number} [opts.wanPort]        – Port to probe for WAN.
   * @param {string[]} [opts.hotspotHosts] – Gateway addresses to probe for HOTSPOT.
   * @param {number} [opts.hotspotPort]    – Port to probe for HOTSPOT.
   */
  constructor(discovery, opts = {}) {
    super();
    this._discovery = discovery;
    this._checkInterval = opts.checkInterval || DEFAULT_CHECK_INTERVAL_MS;
    this._probeTimeout = opts.probeTimeout || DEFAULT_PROBE_TIMEOUT_MS;
    this._wanHost = opts.wanHost || DEFAULT_WAN_HOST;
    this._wanPort = opts.wanPort || DEFAULT_WAN_PORT;
    this._hotspotHosts = opts.hotspotHosts || DEFAULT_HOTSPOT_HOSTS;
    this._hotspotPort = opts.hotspotPort || DEFAULT_HOTSPOT_PORT;
    this._tier = TIERS.NONE;
    this._timer = null;
  }

  /** Connectivity tier constants. */
  static get TIERS() {
    return TIERS;
  }

  /** Current connectivity tier string. */
  get tier() {
    return this._tier;
  }

  /** True when any beyond-LAN connectivity is available (HOTSPOT or WAN). */
  get isOnline() {
    return this._tier === TIERS.HOTSPOT || this._tier === TIERS.WAN;
  }

  /** Start the periodic connectivity check. */
  start() {
    this._timer = setInterval(() => this._check(), this._checkInterval);
    this._timer.unref();
    // Run immediately so callers see the tier right away.
    this._check();
  }

  /** Stop the periodic check. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _check() {
    const tier = await this._determineTier();
    if (tier !== this._tier) {
      const prev = this._tier;
      this._tier = tier;
      this.emit('tier:change', tier, prev);
    }
  }

  async _determineTier() {
    // WAN – highest tier, checked first.
    if (await this._probe(this._wanHost, this._wanPort)) {
      return TIERS.WAN;
    }
    // Hotspot – try each candidate gateway address.
    for (const host of this._hotspotHosts) {
      if (await this._probe(host, this._hotspotPort)) {
        return TIERS.HOTSPOT;
      }
    }
    // LAN – at least one local peer is known.
    if (this._discovery && this._discovery.peers.length > 0) {
      return TIERS.LAN;
    }
    return TIERS.NONE;
  }

  /** TCP probe: resolves true if the connection succeeds within the timeout. */
  _probe(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(this._probeTimeout);
      socket.on('connect', () => finish(true));
      socket.on('timeout', () => finish(false));
      socket.on('error', () => finish(false));
      socket.connect(port, host);
    });
  }
}

module.exports = ConnectivityMonitor;
