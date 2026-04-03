'use strict';

/**
 * messenger.js – Local P2P HTTP messaging.
 *
 * Sends messages to discovered peers and returns delivery results.
 * Failures are non-fatal: the caller decides whether to retry or queue.
 */

const http = require('http');

/**
 * POST a JSON payload to `http://<ip>:<port><path>`.
 * Returns a Promise that resolves to the parsed response body.
 * Rejects on network error or non-2xx status.
 *
 * @param {string} ip
 * @param {number} port
 * @param {string} urlPath
 * @param {object} payload
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>}
 */
function postJson(ip, port, urlPath, payload, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: ip,
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
        } else {
          reject(new Error(`Peer responded with HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class Messenger {
  /**
   * @param {import('./discovery')} discovery  – Discovery instance for peer list.
   * @param {import('./store')} store            – Store to persist received messages.
   */
  constructor(discovery, store) {
    this._discovery = discovery;
    this._store = store;
  }

  /**
   * Broadcast a message to all known peers.
   * @param {object} message  – Fully-formed message object from the Store.
   * @returns {Promise<{ peer: object, ok: boolean, error?: string }[]>}
   */
  async broadcast(message) {
    const peers = this._discovery.peers;
    if (peers.length === 0) return [];

    const results = await Promise.allSettled(
      peers.map((peer) => this._sendToPeer(peer, message))
    );

    return peers.map((peer, i) => {
      const r = results[i];
      return r.status === 'fulfilled'
        ? { peer, ok: true }
        : { peer, ok: false, error: r.reason && r.reason.message };
    });
  }

  /**
   * Send a message to a single peer.
   * @param {{ ip: string, apiPort: number }} peer
   * @param {object} message
   * @returns {Promise<object>}
   */
  _sendToPeer(peer, message) {
    return postJson(peer.ip, peer.apiPort, '/api/messages/receive', message);
  }
}

module.exports = { Messenger, postJson };
