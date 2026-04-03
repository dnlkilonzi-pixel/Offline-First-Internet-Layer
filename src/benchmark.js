'use strict';

/**
 * benchmark.js – Multi-node performance benchmarking.
 *
 * BenchmarkRunner measures four key metrics that determine whether a
 * distributed store is fit for production:
 *
 * ── write(store, n) ───────────────────────────────────────────────────────────
 *   Sequential write throughput: save n messages into a Store, measure the
 *   wall-clock time, and report ops/sec.
 *   This tests raw persistence throughput (WAL + snapshot).
 *
 * ── read(store, n) ────────────────────────────────────────────────────────────
 *   Read throughput: call store.getAll() n times in sequence.
 *   Tests in-memory sort performance under growing working sets.
 *
 * ── antiEntropyRound(storeA, storeB, n) ──────────────────────────────────────
 *   Convergence time: seed storeA with n unique messages, then run one
 *   bidirectional anti-entropy round between A and B using the in-process
 *   transport (no network).  Measures how long it takes B to receive all
 *   n messages (i.e., convergence latency for a fully-diverged pair).
 *
 *   Returns { received, durationMs, msgsPerSec } — the "time to convergence"
 *   metric used to compare distributed store implementations.
 *
 * ── bandwidth(messages) ──────────────────────────────────────────────────────
 *   Sync bandwidth efficiency: given a set of store messages, compute the
 *   byte cost of a single anti-entropy exchange (digest + delta transfer).
 *
 *   Two figures are returned:
 *     digestBytes – cost of transmitting the ID digest (O(n × idLen))
 *     deltaBytes  – worst-case cost of the delta (full set of messages
 *                   serialised to JSON, as sent via /api/push)
 *
 *   Actual exchange cost on a warm (mostly-synced) cluster is:
 *     digestBytes + deltaBytes * missRate
 *   where missRate ≈ 0 for well-connected peers.
 *
 * ── run(store, opts) ─────────────────────────────────────────────────────────
 *   Convenience wrapper: run all benchmarks on a single store, seeding it
 *   from scratch, and return a summary report object.
 */

const AntiEntropy = require('./antientropy');

class BenchmarkRunner {
  // ── Individual benchmark methods ──────────────────────────────────────────

  /**
   * Sequential write throughput.
   *
   * @param {import('./store')} store
   * @param {number} [n=500]
   * @returns {Promise<{ n: number, durationMs: number, opsPerSec: number }>}
   */
  async write(store, n = 500) {
    const start = Date.now();
    for (let i = 0; i < n; i++) {
      await store.save({
        content: `benchmark-write-${i}`,
        sender: `bench-node-${i % 5}`,
        type: 'benchmark',
      });
    }
    const durationMs = Date.now() - start;
    return { n, durationMs, opsPerSec: _opsPerSec(n, durationMs) };
  }

  /**
   * Sequential read throughput (repeated getAll calls).
   *
   * @param {import('./store')} store
   * @param {number} [n=200]
   * @returns {Promise<{ n: number, durationMs: number, opsPerSec: number }>}
   */
  async read(store, n = 200) {
    const start = Date.now();
    for (let i = 0; i < n; i++) {
      await store.getAll();
    }
    const durationMs = Date.now() - start;
    return { n, durationMs, opsPerSec: _opsPerSec(n, durationMs) };
  }

  /**
   * Anti-entropy convergence time.
   *
   * Seeds storeA with n unique messages (storeB has none), then runs a full
   * bidirectional anti-entropy round using an in-process transport (no TCP).
   *
   * @param {import('./store')} storeA – Source (has n messages).
   * @param {import('./store')} storeB – Target (starts empty).
   * @param {number}            [n=100]
   * @returns {Promise<{ n: number, received: number, durationMs: number, msgsPerSec: number }>}
   */
  async antiEntropyRound(storeA, storeB, n = 100) {
    // Seed storeA.
    for (let i = 0; i < n; i++) {
      await storeA.save({ content: `ae-msg-${i}`, sender: `ae-node-${i % 3}`, type: 'ae-bench' });
    }

    const aeA = new AntiEntropy(storeA, 'bench-A');
    const aeB = new AntiEntropy(storeB, 'bench-B');

    // In-process transport: simulate HTTP POST between two AntiEntropy instances.
    const transport = async (_ip, _port, urlPath, body) => {
      if (urlPath === '/api/reconcile') {
        const missing = await aeB.missing(body.ids || []);
        const peerIds = await aeB.digest();
        return { missing, peerIds };
      }
      if (urlPath === '/api/push') {
        await aeB.reconcile(body.messages || []);
        return { accepted: (body.messages || []).length, skipped: 0 };
      }
      throw new Error(`Unknown path: ${urlPath}`);
    };

    const start = Date.now();
    const result = await aeA.syncWithPeer(
      { ip: '127.0.0.1', apiPort: 0, nodeId: 'bench-B' },
      transport,
    );
    const durationMs = Date.now() - start;

    return {
      n,
      received: result.received,
      sent: result.sent,
      durationMs,
      msgsPerSec: _opsPerSec(result.sent, durationMs),
    };
  }

  /**
   * Sync bandwidth efficiency.
   *
   * Computes the byte cost of one anti-entropy exchange for the given messages.
   *
   * @param {object[]} messages – Store messages (e.g. from store.getAll()).
   * @returns {{ messageCount: number, digestBytes: number, deltaBytes: number, totalBytes: number }}
   */
  bandwidth(messages) {
    // Digest: array of UUIDs sent as a JSON array.
    const ids = messages.map((m) => m.id);
    const digestBytes = Buffer.byteLength(JSON.stringify(ids), 'utf8');

    // Delta: worst case — all messages are missing on the peer side.
    const deltaBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');

    return {
      messageCount: messages.length,
      digestBytes,
      deltaBytes,
      totalBytes: digestBytes + deltaBytes,
    };
  }

  /**
   * Run all benchmarks sequentially and return a consolidated report.
   *
   * @param {import('./store')} storeA – Primary benchmark store (written to).
   * @param {import('./store')} storeB – Secondary store used for AE round.
   * @param {object}            [opts]
   * @param {number}            [opts.writeN=200]   – Messages to write.
   * @param {number}            [opts.readN=100]    – Read iterations.
   * @param {number}            [opts.aeN=50]       – AE convergence messages.
   * @returns {Promise<BenchmarkReport>}
   */
  async run(storeA, storeB, opts = {}) {
    const { writeN = 200, readN = 100, aeN = 50 } = opts;

    const writeResult  = await this.write(storeA, writeN);
    const readResult   = await this.read(storeA, readN);
    const aeResult     = await this.antiEntropyRound(storeA, storeB, aeN);
    const allMessages  = await storeA.getAll();
    const bwResult     = this.bandwidth(allMessages);

    return {
      write:       writeResult,
      read:        readResult,
      antiEntropy: aeResult,
      bandwidth:   bwResult,
      timestamp:   new Date().toISOString(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * @param {number} ops
 * @param {number} durationMs
 * @returns {number}
 */
function _opsPerSec(ops, durationMs) {
  if (durationMs === 0) return Infinity;
  return Math.round((ops / durationMs) * 1000);
}

module.exports = BenchmarkRunner;

/**
 * @typedef {object} BenchmarkReport
 * @property {{ n: number, durationMs: number, opsPerSec: number }} write
 * @property {{ n: number, durationMs: number, opsPerSec: number }} read
 * @property {{ n: number, received: number, durationMs: number, msgsPerSec: number }} antiEntropy
 * @property {{ messageCount: number, digestBytes: number, deltaBytes: number, totalBytes: number }} bandwidth
 * @property {string} timestamp
 */
