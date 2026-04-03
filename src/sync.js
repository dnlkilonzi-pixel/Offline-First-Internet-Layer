'use strict';

/**
 * sync.js – Internet connectivity monitor + sync engine.
 *
 * Periodically checks whether the internet is reachable by attempting
 * a TCP connection to a well-known host.  When connectivity is restored
 * all unsynced messages are pushed to the configured remote endpoint.
 *
 * Events emitted:
 *   'online'          – internet became reachable
 *   'offline'         – internet became unreachable
 *   'sync:start'      – batch sync run started
 *   'sync:done'       (results) – batch sync finished
 *   'sync:error'      (err) – individual sync error
 */

const net = require('net');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');

const CHECK_INTERVAL_MS = 10_000;
const CHECK_HOST = '8.8.8.8';
const CHECK_PORT = 53;
const CHECK_TIMEOUT_MS = 3_000;

class SyncEngine extends EventEmitter {
  /**
   * @param {import('./store')} store    – Message store.
   * @param {object} [opts]
   * @param {string}  [opts.remoteUrl]     – Full URL of the remote POST endpoint.
   *   E.g. "https://my-server.example.com/api/sync"
   * @param {number}  [opts.checkInterval] – ms between connectivity probes.
   * @param {string}  [opts.checkHost]     – Host to probe (TCP).
   * @param {number}  [opts.checkPort]     – Port to probe.
   * @param {number}  [opts.checkTimeout]  – ms before a probe attempt times out.
   */
  constructor(store, opts = {}) {
    super();
    this._store = store;
    this._remoteUrl = opts.remoteUrl || null;
    this._checkInterval = opts.checkInterval || CHECK_INTERVAL_MS;
    this._checkHost = opts.checkHost || CHECK_HOST;
    this._checkPort = opts.checkPort || CHECK_PORT;
    this._checkTimeout = opts.checkTimeout || CHECK_TIMEOUT_MS;
    this._online = false;
    this._syncing = false;
    this._timer = null;
  }

  /** Current connectivity state. */
  get isOnline() {
    return this._online;
  }

  /** Start the periodic connectivity check. */
  start() {
    this._timer = setInterval(() => this._check(), this._checkInterval);
    // Allow Node.js to exit even if the timer is still running.
    this._timer.unref();
    // Run an immediate check so the UI reflects state quickly.
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
        // Drain the response so the socket is released.
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
