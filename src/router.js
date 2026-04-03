'use strict';

/**
 * router.js – Gossip propagation with TTL hops and selective forwarding.
 *
 * Every message that traverses the mesh carries two routing fields:
 *
 *   ttl   {number}   – Remaining hop budget; decremented on each forward.
 *                      A message with ttl === 0 is NOT forwarded further.
 *   hops  {string[]} – Node IDs that have already forwarded this message.
 *                      Used to avoid sending the message back to a node
 *                      that has already seen it (loop prevention).
 *
 * Lifecycle of a locally-originated message:
 *   1. stampOrigin(msg)   → adds ttl=DEFAULT_TTL, hops=[]
 *   2. selectPeers(peers, msg) → all peers (hops is empty)
 *   3. Peer receives → shouldAccept → stores → shouldForward → prepareForward → selectPeers → forward
 *   …repeat until ttl reaches 0 or all peers have seen the message.
 */

const DEFAULT_TTL = 5;

class Router {
  /**
   * @param {string} nodeId – This node's unique identifier.
   */
  constructor(nodeId) {
    this._nodeId = nodeId;
  }

  /**
   * Should this node accept and store an incoming message?
   * Rejects messages that have already visited this node (loop detection).
   *
   * @param {object} message
   * @returns {boolean}
   */
  shouldAccept(message) {
    const hops = message.hops || [];
    return !hops.includes(this._nodeId);
  }

  /**
   * Should this node forward the message further into the mesh?
   * Requires: ttl > 0 AND this node hasn't already forwarded it.
   *
   * @param {object} message
   * @returns {boolean}
   */
  shouldForward(message) {
    const ttl = message.ttl !== undefined ? message.ttl : DEFAULT_TTL;
    return ttl > 0 && this.shouldAccept(message);
  }

  /**
   * Produce a copy of the message ready for forwarding:
   * decrements TTL by 1 and appends this node to the hops list.
   *
   * @param {object} message
   * @returns {object}
   */
  prepareForward(message) {
    const ttl = message.ttl !== undefined ? message.ttl : DEFAULT_TTL;
    return {
      ...message,
      ttl: ttl - 1,
      hops: [...(message.hops || []), this._nodeId],
    };
  }

  /**
   * Filter a peer list to only those who should receive this message.
   * Excludes peers already in the hops list (they've seen it).
   *
   * @param {object[]} peers   – Array of peer objects with a `nodeId` field.
   * @param {object}   message
   * @returns {object[]}
   */
  selectPeers(peers, message) {
    const seen = new Set(message.hops || []);
    return peers.filter((p) => !seen.has(p.nodeId));
  }

  /**
   * Stamp a brand-new locally-originated message with default routing fields.
   *
   * @param {object} message
   * @returns {object}
   */
  stampOrigin(message) {
    return {
      ...message,
      ttl: DEFAULT_TTL,
      hops: [],
    };
  }

  /** Default TTL value applied to new messages. */
  static get DEFAULT_TTL() {
    return DEFAULT_TTL;
  }
}

module.exports = Router;
