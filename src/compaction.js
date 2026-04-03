'use strict';

/**
 * compaction.js – Log compaction and trimming.
 *
 * As the event log grows indefinitely, compaction prevents unbounded storage:
 *
 * ── compact() ────────────────────────────────────────────────────────────────
 *   Document compaction: for EventBus events that belong to a document
 *   (serialised JSON with a `docId` field in the `content` column), keep
 *   only the latest version per (type, docId) pair.  Older superseded versions
 *   are removed.
 *
 *   Safe because the latest event already encodes the full document state
 *   in the LWW-register model.
 *
 *   CRDT events (type starts with 'crdt:') are never compacted because their
 *   full history is required to recompute the merged CRDT value.
 *
 * ── trim(opts) ────────────────────────────────────────────────────────────────
 *   Time- and count-based trimming:
 *     maxAge    {number} – Remove messages older than this many milliseconds.
 *     maxCount  {number} – Keep only the most-recent N non-CRDT messages.
 *
 *   CRDT events are never trimmed to preserve convergence correctness.
 *
 * ── schedule(intervalMs, trimOpts) ───────────────────────────────────────────
 *   Run a combined compact+trim pass periodically.
 *
 * Events emitted:
 *   'compact:done'  ({ removed })        – compact pass finished
 *   'trim:done'     ({ removed })        – trim pass finished
 *   'gc:done'       ({ compacted, trimmed }) – combined pass finished
 *   'error'         (err)                – internal error
 */

const EventEmitter = require('events');
const LamportClock = require('./clock');

const CRDT_TYPE_PREFIX = 'crdt:';

class Compaction extends EventEmitter {
  /**
   * @param {import('./store')} store
   */
  constructor(store) {
    super();
    this._store = store;
    this._timer = null;
  }

  /**
   * Compact document events: keep only the latest version per (type, docId).
   * Non-document and CRDT events are left untouched.
   *
   * @returns {Promise<number>} Number of messages removed.
   */
  async compact() {
    const all = this._store._messages.slice(); // work on a snapshot
    const latestPerDoc = new Map();            // `type:docId` → store message
    const toRemove = new Set();

    for (const msg of all) {
      // Never compact CRDT events.
      if (msg.type && msg.type.startsWith(CRDT_TYPE_PREFIX)) continue;

      // Only compact EventBus events that carry a docId in their JSON content.
      let evt = null;
      try { evt = JSON.parse(msg.content); } catch (_) { /* raw message */ }
      if (!evt || !evt.docId) continue;

      const key = `${evt.type}:${evt.docId}`;
      const existing = latestPerDoc.get(key);

      if (!existing) {
        latestPerDoc.set(key, { msg, lamport: evt.lamport !== undefined ? evt.lamport : (msg.lamport || 0) });
      } else {
        const incomingL = evt.lamport !== undefined ? evt.lamport : (msg.lamport || 0);
        if (incomingL > existing.lamport) {
          toRemove.add(existing.msg.id);
          latestPerDoc.set(key, { msg, lamport: incomingL });
        } else {
          toRemove.add(msg.id);
        }
      }
    }

    if (toRemove.size > 0) {
      this._store.deleteMessages([...toRemove]);
      // Truncate the WAL after compaction so it does not grow unboundedly.
      if (typeof this._store.snapshot === 'function') {
        this._store.snapshot();
      }
      this.emit('compact:done', { removed: toRemove.size });
    }
    return toRemove.size;
  }

  /**
   * Trim messages by age and/or count.  CRDT events are never trimmed.
   *
   * @param {object} opts
   * @param {number} [opts.maxAge]   – Remove non-CRDT messages older than this many ms.
   * @param {number} [opts.maxCount] – Keep only the most-recent N non-CRDT messages.
   * @returns {Promise<number>} Number of messages removed.
   */
  async trim(opts = {}) {
    const { maxAge, maxCount } = opts;
    const toRemove = new Set();

    // Separate CRDT events (never trimmed) from regular ones.
    const regular = this._store._messages.filter(
      (m) => !m.type || !m.type.startsWith(CRDT_TYPE_PREFIX)
    );

    // Sort newest-first (by Lamport descending) for count-based trim.
    const sorted = [...regular].sort((a, b) => LamportClock.compare(b, a));

    if (maxCount !== undefined && sorted.length > maxCount) {
      for (let i = maxCount; i < sorted.length; i++) {
        toRemove.add(sorted[i].id);
      }
    }

    if (maxAge !== undefined) {
      const cutoff = Date.now() - maxAge;
      for (const msg of regular) {
        if (!toRemove.has(msg.id)) {
          const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
          if (ts < cutoff) toRemove.add(msg.id);
        }
      }
    }

    if (toRemove.size > 0) {
      this._store.deleteMessages([...toRemove]);
      // Truncate the WAL after trimming.
      if (typeof this._store.snapshot === 'function') {
        this._store.snapshot();
      }
      this.emit('trim:done', { removed: toRemove.size });
    }
    return toRemove.size;
  }

  /**
   * Schedule periodic compaction + trimming.
   *
   * @param {number} intervalMs – How often to run (milliseconds).
   * @param {object} [trimOpts] – Options forwarded to trim().
   * @returns {this}
   */
  schedule(intervalMs, trimOpts = {}) {
    this._timer = setInterval(async () => {
      try {
        const compacted = await this.compact();
        const trimmed = await this.trim(trimOpts);
        if (compacted > 0 || trimmed > 0) {
          this.emit('gc:done', { compacted, trimmed });
        }
      } catch (err) {
        this.emit('error', err);
      }
    }, intervalMs);
    this._timer.unref();
    return this;
  }

  /** Stop the scheduled compaction timer. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = Compaction;
