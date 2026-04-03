'use strict';

/**
 * messenger.js – Local P2P HTTP messaging with gossip routing.
 *
 * Sends messages to discovered peers using the Router's selective-forwarding
 * rules: only peers that have not already seen the message (not in hops list)
 * receive a copy, and the TTL is decremented before forwarding.
 *
 * Failures are non-fatal: the caller decides whether to retry or queue.
 */

const http = require('http');
const Router = require('./router');

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
   * @param {import('./store')}     store       – Store to persist received messages.
   * @param {import('./router')}    [router]    – Gossip router (optional; falls back
   *                                             to broadcasting to all peers).
   */
  constructor(discovery, store, router) {
    this._discovery = discovery;
    this._store = store;
    this._router = router || null;
  }

  /**
   * Broadcast a locally-originated or forwarded message to eligible peers.
   *
   * When a Router is configured:
   *   - Uses router.selectPeers() to skip peers that have already seen the message.
   *   - Uses router.prepareForward() to decrement TTL and record this hop.
   *
   * @param {object} message  – Fully-formed message object (may include ttl/hops).
   * @returns {Promise<{ peer: object, ok: boolean, error?: string }[]>}
   */
  async broadcast(message) {
    const allPeers = this._discovery.peers;
    if (allPeers.length === 0) return [];

    const peers = this._router
      ? this._router.selectPeers(allPeers, message)
      : allPeers;

    if (peers.length === 0) return [];

    const forwardMsg = this._router
      ? this._router.prepareForward(message)
      : message;

    const results = await Promise.allSettled(
      peers.map((peer) => this._sendToPeer(peer, forwardMsg))
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
