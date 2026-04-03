'use strict';

/**
 * sync.js – Internet connectivity monitor + multi-tier sync engine.
 *
 * When a ConnectivityMonitor is provided the SyncEngine delegates all
 * connectivity detection to it and maps each tier to a sync strategy:
 *
 *   WAN     → push unsynced messages to the remote endpoint immediately.
 *   HOTSPOT → schedule a delayed batch push (opportunistic / DTN-style).
 *   LAN     → local peer gossip is already handling replication; no remote push.
 *   NONE    → queue locally; wait.
 *
 * When no ConnectivityMonitor is provided the engine falls back to its own
 * TCP probe (original behaviour) for backward compatibility.
 *
 * Events emitted:
 *   'online'          – WAN or HOTSPOT connectivity became available.
 *   'offline'         – Connectivity dropped below HOTSPOT.
 *   'tier:change'     (tier, prev) – Forwarded from ConnectivityMonitor.
 *   'sync:start'      – Batch sync run started.
 *   'sync:done'       (results) – Batch sync finished.
 *   'sync:error'      (err) – Individual sync error.
 */

const net = require('net');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');

const CHECK_INTERVAL_MS = 10_000;
const CHECK_HOST = '8.8.8.8';
const CHECK_PORT = 53;
const CHECK_TIMEOUT_MS = 3_000;
// Delay before pushing when only a HOTSPOT (limited WAN) is available.
const DEFAULT_HOTSPOT_DELAY_MS = 30_000;

class SyncEngine extends EventEmitter {
  /**
   * @param {import('./store')} store    – Message store.
   * @param {object} [opts]
   * @param {string}  [opts.remoteUrl]       – Full URL of the remote POST endpoint.
   * @param {number}  [opts.checkInterval]   – ms between connectivity probes (standalone mode).
   * @param {string}  [opts.checkHost]       – Host to probe (standalone mode).
   * @param {number}  [opts.checkPort]       – Port to probe (standalone mode).
   * @param {number}  [opts.checkTimeout]    – Probe timeout ms (standalone mode).
   * @param {number}  [opts.hotspotDelayMs]  – Delay before syncing on HOTSPOT tier.
   * @param {import('./connectivity')} [opts.connectivity] – Multi-tier monitor.
   */
  constructor(store, opts = {}) {
    super();
    this._store = store;
    this._remoteUrl = opts.remoteUrl || null;
    this._checkInterval = opts.checkInterval || CHECK_INTERVAL_MS;
    this._checkHost = opts.checkHost || CHECK_HOST;
    this._checkPort = opts.checkPort || CHECK_PORT;
    this._checkTimeout = opts.checkTimeout || CHECK_TIMEOUT_MS;
    this._hotspotDelayMs = opts.hotspotDelayMs || DEFAULT_HOTSPOT_DELAY_MS;
    this._connectivity = opts.connectivity || null;
    this._online = false;
    this._syncing = false;
    this._timer = null;
    this._hotspotTimer = null;
  }

  /** Current connectivity state (true for HOTSPOT or WAN). */
  get isOnline() {
    return this._online;
  }

  /** Start the engine. */
  start() {
    if (this._connectivity) {
      this._attachConnectivityMonitor();
    } else {
      // Standalone mode: own TCP probe.
      this._timer = setInterval(() => this._check(), this._checkInterval);
      this._timer.unref();
      this._check();
    }
  }

  /** Stop all timers. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._hotspotTimer) {
      clearTimeout(this._hotspotTimer);
      this._hotspotTimer = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Wire up a ConnectivityMonitor instead of our own probe. */
  _attachConnectivityMonitor() {
    const cm = this._connectivity;
    const { TIERS } = require('./connectivity');

    cm.on('tier:change', (tier, prev) => {
      this.emit('tier:change', tier, prev);

      const wasOnline = this._online;
      this._online = tier === TIERS.WAN || tier === TIERS.HOTSPOT;

      if (this._online && !wasOnline) {
        this.emit('online');
      } else if (!this._online && wasOnline) {
        this.emit('offline');
        this._cancelHotspotSync();
      }

      if (this._remoteUrl) {
        if (tier === TIERS.WAN) {
          this._cancelHotspotSync();
          this._syncAll().catch((err) => this.emit('sync:error', err));
        } else if (tier === TIERS.HOTSPOT) {
          this._scheduleHotspotSync();
        }
      }
    });
  }

  _scheduleHotspotSync() {
    this._cancelHotspotSync();
    this._hotspotTimer = setTimeout(() => {
      this._syncAll().catch((err) => this.emit('sync:error', err));
    }, this._hotspotDelayMs);
  }

  _cancelHotspotSync() {
    if (this._hotspotTimer) {
      clearTimeout(this._hotspotTimer);
      this._hotspotTimer = null;
    }
  }

  // ── Standalone probe (used when no ConnectivityMonitor provided) ──────────

  async _check() {
    const reachable = await this._probe();
    if (reachable && !this._online) {
      this._online = true;
      this.emit('online');
      if (this._remoteUrl) {
        this._syncAll().catch((err) => this.emit('sync:error', err));
      }
    } else if (!reachable && this._online) {
      this._online = false;
      this.emit('offline');
    }
  }

  /** TCP probe – resolves true if the connection succeeds. */
  _probe() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(this._checkTimeout);
      socket.on('connect', () => finish(true));
      socket.on('timeout', () => finish(false));
      socket.on('error', () => finish(false));
      socket.connect(this._checkPort, this._checkHost);
    });
  }

  // ── Sync logic ────────────────────────────────────────────────────────────

  /**
   * Push all unsynced messages to the remote endpoint.
   * @returns {Promise<{ id: string, ok: boolean }[]>}
   */
  async _syncAll() {
    if (this._syncing) return [];
    this._syncing = true;
    this.emit('sync:start');

    const pending = await this._store.getUnsynced();
    const results = [];

    for (const msg of pending) {
      try {
        await this._postToRemote(msg);
        await this._store.markSynced(msg.id);
        results.push({ id: msg.id, ok: true });
      } catch (err) {
        results.push({ id: msg.id, ok: false, error: err.message });
        this.emit('sync:error', err);
      }
    }

    this._syncing = false;
    this.emit('sync:done', results);
    return results;
  }

  /**
   * POST a single message object to the remote sync endpoint.
   * Supports both http:// and https:// URLs.
   * @param {object} message
   * @returns {Promise<void>}
   */
  _postToRemote(message) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._remoteUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const body = JSON.stringify(message);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8_000,
      };

      const req = lib.request(options, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Remote responded with HTTP ${res.statusCode}`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Sync request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Manually trigger a sync run (useful from the API or tests).
   * @returns {Promise<{ id: string, ok: boolean }[]>}
   */
  async syncNow() {
    if (!this._remoteUrl) {
      return [];
    }
    return this._syncAll();
  }
}

module.exports = SyncEngine;
