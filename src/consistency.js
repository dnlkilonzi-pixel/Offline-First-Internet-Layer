'use strict';

/**
 * consistency.js – Formal consistency model declaration and session tracking.
 *
 * ── Why this matters ──────────────────────────────────────────────────────────
 *   A distributed system whose behaviour is correct but not formally specified
 *   cannot be reasoned about by operators, clients, or auditors.  This module
 *   makes OFIL's consistency contract explicit and machine-checkable.
 *
 * ── Guarantees provided by OFIL ──────────────────────────────────────────────
 *   Model            Eventual Consistency (EC)
 *   CAP category     AP — Available + Partition-tolerant;
 *                    consistency is sacrificed for liveness during a partition.
 *   Ordering         Causal ordering via vector clocks; total order via
 *                    Lamport timestamp + node-id tiebreak.
 *   Conflict res.    Documents: Last-Write-Wins (LWW) via Lamport + sender id.
 *                    Sets: Add-Wins ORSet (concurrent add+remove → add wins).
 *                    Counters: GCounter (merge = max per node partition).
 *   Convergence      Digest-based anti-entropy on reconnection; all correct
 *                    nodes that have seen the same set of writes will hold
 *                    identical state.
 *   Partition heal   Anti-entropy triggered automatically on tier:change.
 *
 * ── Per-session guarantees ────────────────────────────────────────────────────
 *   Within a named session (identified by a string sessionId) the monitor
 *   enforces two additional guarantees on top of EC:
 *
 *   Read Your Writes (RYW)
 *     A session that has written event E will always see E in subsequent reads.
 *     checkRead() returns { readYourWrites: false } when a pending write is
 *     not yet visible in the supplied event list.
 *
 *   Monotonic Reads (MR)
 *     Once a session has seen events up to Lamport time T, it will never
 *     observe a set of events whose maximum Lamport value is less than T.
 *     checkRead() returns { monotonic: false } when the new event set
 *     has regressed below the session's high-watermark.
 *
 * ── Session lifecycle ─────────────────────────────────────────────────────────
 *   1. registerWrite(sessionId, event)  – record an event the session wrote.
 *   2. checkRead(sessionId, events)     – verify guarantees for a read result.
 *   3. advanceRead(sessionId, lamport)  – advance the high-watermark after a read.
 *   4. destroySession(sessionId)        – release session state.
 */

const GUARANTEES = Object.freeze({
  model: 'Eventual Consistency (EC)',
  cap: 'AP — Available + Partition-tolerant',
  sessionGuarantees: ['Read Your Writes (RYW)', 'Monotonic Reads (MR)'],
  conflictResolution: Object.freeze({
    documents: 'Last-Write-Wins (LWW) via Lamport clock + node-id tiebreak',
    sets: 'Add-Wins ORSet — concurrent add and remove leaves the element present',
    counters: 'GCounter — merge = max per node partition; strictly grow-only',
  }),
  causalOrdering: 'Vector clocks track causal ancestry; buildCausalGraph() exposes direct-parent lineage',
  convergence: 'Digest-based anti-entropy: only the delta is transferred on each reconciliation round',
  partitionHealing: 'Anti-entropy fires automatically on connectivity tier:change from NONE',
  guaranteesBoundary: 'Session guarantees (RYW, MR) hold within a named session. Cross-session: eventual.',
  storeDurability: 'Write-Ahead Log (WAL) + atomic snapshot (tmp→rename) — no write is lost on crash',
});

class ConsistencyMonitor {
  constructor() {
    /** @type {Map<string, { highWatermark: number, writes: Set<string> }>} */
    this._sessions = new Map();
  }

  // ── Session management ──────────────────────────────────────────────────────

  /**
   * Record that this session has written an event.
   * Used for Read-Your-Writes verification.
   *
   * @param {string} sessionId
   * @param {{ id: string, lamport?: number }} event
   */
  registerWrite(sessionId, event) {
    const s = this._getOrCreate(sessionId);
    s.writes.add(event.id);
    s.highWatermark = Math.max(s.highWatermark, event.lamport || 0);
  }

  /**
   * Advance the session's Lamport high-watermark without registering a write.
   * Call this after a successful read so the session tracks its read frontier.
   *
   * @param {string} sessionId
   * @param {number} lamport
   */
  advanceRead(sessionId, lamport) {
    const s = this._getOrCreate(sessionId);
    s.highWatermark = Math.max(s.highWatermark, lamport);
  }

  /**
   * Verify that a set of events satisfies the session's guarantees.
   *
   * @param {string} sessionId
   * @param {Array<{ id: string, lamport?: number }>} events
   * @returns {{ monotonic: boolean, readYourWrites: boolean, ok: boolean }}
   */
  checkRead(sessionId, events) {
    const s = this._sessions.get(sessionId);

    // No session state yet — all guarantees trivially satisfied.
    if (!s) {
      return { monotonic: true, readYourWrites: true, ok: true };
    }

    // Monotonic Reads: the maximum Lamport in the returned set must be ≥ the
    // session's high-watermark.  A value strictly less means the caller
    // received a stale snapshot that has regressed in time.
    const maxInSet = events.reduce((max, e) => Math.max(max, e.lamport || 0), 0);
    const monotonic = maxInSet >= s.highWatermark || events.length === 0;

    // Read Your Writes: every event the session has written must appear in the
    // returned set.  If a write is not yet visible, RYW is violated.
    const eventIds = new Set(events.map((e) => e.id));
    const readYourWrites = [...s.writes].every((id) => eventIds.has(id));

    return { monotonic, readYourWrites, ok: monotonic && readYourWrites };
  }

  /**
   * Return the current state of a session, or null if unknown.
   * @param {string} sessionId
   * @returns {{ highWatermark: number, pendingWrites: number } | null}
   */
  getSessionState(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return { highWatermark: s.highWatermark, pendingWrites: s.writes.size };
  }

  /**
   * Release all state held for a session (e.g. on client disconnect).
   * @param {string} sessionId
   */
  destroySession(sessionId) {
    this._sessions.delete(sessionId);
  }

  /** Number of currently tracked sessions. */
  get sessionCount() {
    return this._sessions.size;
  }

  // ── Static ─────────────────────────────────────────────────────────────────

  /**
   * The formal consistency guarantee declaration for OFIL.
   * This is the authoritative specification of what the system promises.
   */
  static get GUARANTEES() {
    return GUARANTEES;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _getOrCreate(sessionId) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, { highWatermark: 0, writes: new Set() });
    }
    return this._sessions.get(sessionId);
  }
}

module.exports = ConsistencyMonitor;
