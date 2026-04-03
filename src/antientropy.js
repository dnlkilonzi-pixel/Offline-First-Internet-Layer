'use strict';

/**
 * antientropy.js – Digest-based anti-entropy reconciliation.
 *
 * Anti-entropy is the mechanism that heals divergence after network partitions.
 * Instead of flooding every message on every gossip round, two nodes exchange
 * compact state digests (the set of all message IDs they know) and transfer
 * only the delta.  This eliminates redundant retransmissions at scale.
 *
 * ── Protocol (bidirectional, 2 HTTP round-trips) ──────────────────────────────
 *
 *   A initiates anti-entropy with B:
 *
 *   Round 1  A → B:
 *     A sends its ID digest to B     (POST /api/reconcile { ids: A's IDs })
 *     B responds with:
 *       • missing  – messages B has that A doesn't know about
 *       • peerIds  – B's own ID list (so A can compute what B is missing)
 *
 *   Round 2  A → B (push):
 *     A computes diff(A's IDs, B's IDs) = messages B is missing
 *     A pushes those messages to B    (POST /api/push { messages: [...] })
 *
 * Both directions are covered in a single syncWithPeer() call.
 *
 * ── Server endpoints (registered in server.js) ────────────────────────────────
 *   GET  /api/digest       → { ids: string[] }
 *   POST /api/reconcile    → body: { ids: string[] }
 *                          → resp: { missing: object[], peerIds: string[] }
 *   POST /api/push         → body: { messages: object[] }
 *                          → resp: { accepted: number, skipped: number }
 *
 * Events emitted:
 *   'reconciled'   ({ accepted, skipped })      – batch ingestion complete
 *   'sync:complete' ({ peer, received, sent })  – full peer sync round done
 *   'sync:error'   ({ peer, err })              – transport error during sync
 */

const EventEmitter = require('events');

class AntiEntropy extends EventEmitter {
  /**
   * @param {import('./store')} store
   * @param {string}            nodeId
   */
  constructor(store, nodeId) {
    super();
    this._store = store;
    this._nodeId = nodeId;
  }

  // ── Core storage-level operations ──────────────────────────────────────────

  /**
   * Compute the current state digest: the set of all known message IDs.
   * This is the compact "what this node knows" representation.
   * @returns {Promise<string[]>}
   */
  async digest() {
    const msgs = await this._store.getAll();
    return msgs.map((m) => m.id);
  }

  /**
   * Given a peer's set of known IDs, return all messages in local storage
   * that the peer is missing.
   *
   * @param {string[]} knownIds – Message IDs the requesting peer already has.
   * @returns {Promise<object[]>}
   */
  async missing(knownIds) {
    const known = new Set(knownIds);
    const all = await this._store.getAll();
    return all.filter((m) => !known.has(m.id));
  }

  /**
   * Reconcile: ingest a batch of messages received from a peer.
   * Idempotent — duplicate IDs are silently skipped.
   *
   * @param {object[]} messages – Raw store messages.
   * @returns {Promise<{ accepted: number, skipped: number }>}
   */
  async reconcile(messages) {
    let accepted = 0;
    let skipped = 0;
    for (const msg of (messages || [])) {
      try {
        if (!msg || !msg.content || !msg.sender) { skipped++; continue; }
        await this._store.save(msg);
        accepted++;
      } catch (_) {
        skipped++;
      }
    }
    this.emit('reconciled', { accepted, skipped });
    return { accepted, skipped };
  }

  // ── Peer-level sync ────────────────────────────────────────────────────────

  /**
   * Full bidirectional anti-entropy round with one peer.
   *
   * @param {{ ip: string, apiPort: number, nodeId: string }} peer
   * @param {Function} postJson – postJson(ip, port, path, payload) → Promise<object>
   * @returns {Promise<{ received: number, sent: number }>}
   */
  async syncWithPeer(peer, postJson) {
    const localIds = await this.digest();

    // Round 1: tell the peer our digest; receive what we're missing + their digest.
    let peerResponse;
    try {
      peerResponse = await postJson(peer.ip, peer.apiPort, '/api/reconcile', { ids: localIds });
    } catch (err) {
      this.emit('sync:error', { peer, err });
      return { received: 0, sent: 0 };
    }

    // Ingest messages peer has that we don't.
    const peerMissing = peerResponse.missing || [];
    if (peerMissing.length > 0) {
      await this.reconcile(peerMissing);
    }

    // Round 2: push messages the peer is missing to it.
    const peerIds = peerResponse.peerIds || [];
    const toSend = await this.missing(peerIds);
    let sent = 0;
    if (toSend.length > 0) {
      try {
        await postJson(peer.ip, peer.apiPort, '/api/push', { messages: toSend });
        sent = toSend.length;
      } catch (_) {
        // Non-fatal; peer will receive it on the next anti-entropy round.
      }
    }

    this.emit('sync:complete', { peer, received: peerMissing.length, sent });
    return { received: peerMissing.length, sent };
  }
}

module.exports = AntiEntropy;
