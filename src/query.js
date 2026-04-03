'use strict';

/**
 * query.js – Secondary-index query engine.
 *
 * QueryEngine sits on top of Store and provides:
 *
 * ── Secondary indexes ─────────────────────────────────────────────────────────
 *   Beyond the type index already maintained in Store, QueryEngine keeps:
 *     sender  → Map<senderValue, Set<id>>  (equality index)
 *     synced  → Map<'true'|'false', Set<id>>  (equality index)
 *
 *   The store's type index is also accessible through QueryEngine so that all
 *   equality-index look-ups go through one place.
 *
 * ── Query planner ─────────────────────────────────────────────────────────────
 *   query(q) inspects the filter predicates and selects the cheapest plan:
 *
 *     1. If any equality predicate targets an indexed field (type, sender,
 *        synced), use an index scan (O(k) where k = matching messages).
 *     2. Otherwise fall back to a sequential full scan (O(n)).
 *
 *   explain(q) returns the chosen plan descriptor without executing the query.
 *   This is useful for tests and diagnostics.
 *
 * ── Filter operators ─────────────────────────────────────────────────────────
 *   eq          – strict equality (===)
 *   ne          – strict inequality (!==)
 *   gt / gte    – greater-than / greater-than-or-equal  (numbers & strings)
 *   lt / lte    – less-than    / less-than-or-equal     (numbers & strings)
 *   contains    – substring match (string fields only)
 *   startsWith  – string prefix match
 *
 * ── Query shape ───────────────────────────────────────────────────────────────
 *   {
 *     filter:  Predicate | Predicate[],  // see below
 *     orderBy: 'lamport'|'timestamp'|string,
 *     order:   'asc'|'desc',
 *     limit:   number,
 *     offset:  number,
 *   }
 *
 *   Predicate: { field: string, op?: Op, value: any }
 *   (op defaults to 'eq' when omitted)
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────────
 *   Call index(message)  to keep the engine in sync with newly saved messages.
 *   Call rebuild()       to reconstruct all secondary indexes from the store
 *                        (required after external bulk operations such as
 *                         anti-entropy reconciliation or compaction).
 */

class QueryEngine {
  /**
   * @param {import('./store')} store – The backing Store instance.
   */
  constructor(store) {
    this._store = store;
    /** @type {Map<string, Set<string>>} sender → Set<id> */
    this._senderIndex = new Map();
    /** @type {Map<string, Set<string>>} 'true'|'false' → Set<id> */
    this._syncedIndex = new Map();
    this.rebuild();
  }

  // ── Index maintenance ─────────────────────────────────────────────────────

  /**
   * Rebuild all secondary indexes from the current store contents.
   * O(n) — call after bulk external mutations.
   */
  rebuild() {
    this._senderIndex = new Map();
    this._syncedIndex = new Map();
    for (const msg of this._store._messages) {
      this._indexOne(msg);
    }
  }

  /**
   * Add a single message to the secondary indexes.
   * Call this immediately after every store.save() to keep indexes current.
   *
   * @param {{ id: string, sender: string, synced: boolean }} message
   */
  index(message) {
    this._indexOne(message);
  }

  /** @private */
  _indexOne(msg) {
    // sender equality index
    const sender = msg.sender || '';
    if (!this._senderIndex.has(sender)) this._senderIndex.set(sender, new Set());
    this._senderIndex.get(sender).add(msg.id);

    // synced equality index
    const syncedKey = String(Boolean(msg.synced));
    if (!this._syncedIndex.has(syncedKey)) this._syncedIndex.set(syncedKey, new Set());
    this._syncedIndex.get(syncedKey).add(msg.id);
  }

  // ── Query planning ────────────────────────────────────────────────────────

  /**
   * Return the execution plan that would be used for the given query without
   * actually running it.  Useful for introspection and tests.
   *
   * @param {object} q – Query object (same shape as query()).
   * @returns {{ strategy: 'index'|'fullScan', field?: string, value?: any, estimatedCandidates: number }}
   */
  explain(q = {}) {
    const predicates = this._normalise(q.filter);
    return this._plan(predicates, /* dryRun */ true);
  }

  // ── Public query API ──────────────────────────────────────────────────────

  /**
   * Execute a query over the store.
   *
   * @param {object} q
   * @param {object|object[]} [q.filter]    – Predicate or array of predicates.
   * @param {string}          [q.orderBy]   – Sort field. Default: 'lamport'.
   * @param {'asc'|'desc'}    [q.order]     – Sort direction. Default: 'desc'.
   * @param {number}          [q.limit]     – Maximum number of results.
   * @param {number}          [q.offset=0]  – Skip first N results.
   * @returns {object[]} Matching store messages.
   */
  query(q = {}) {
    const { orderBy = 'lamport', order = 'desc', limit, offset = 0 } = q;
    const predicates = this._normalise(q.filter);

    // 1. Candidate selection via planner.
    const { candidates } = this._plan(predicates, false);

    // 2. Post-filter (applies ALL predicates; index candidates are pre-filtered
    //    on the first equality predicate only, so we re-check everything).
    const filtered = predicates.length
      ? candidates.filter((msg) => this._applyAll(msg, predicates))
      : candidates;

    // 3. Sort.
    filtered.sort((a, b) => {
      const av = a[orderBy];
      const bv = b[orderBy];
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return order === 'asc' ? cmp : -cmp;
    });

    // 4. Offset + limit.
    const start = Math.max(0, offset);
    return limit !== undefined ? filtered.slice(start, start + limit) : filtered.slice(start);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Normalise filter to an array of predicate objects. @private */
  _normalise(filter) {
    if (!filter) return [];
    if (Array.isArray(filter)) return filter.filter(Boolean);
    if (typeof filter === 'object') return [filter];
    return [];
  }

  /**
   * Select a set of candidate messages using the best available plan.
   * @param {object[]} predicates
   * @param {boolean}  dryRun – When true, return plan metadata only (no data fetch).
   * @returns {{ strategy: string, field?: string, value?: any, estimatedCandidates: number, candidates?: object[] }}
   * @private
   */
  _plan(predicates, dryRun) {
    // Look for the first equality predicate on an indexed field.
    for (const pred of predicates) {
      const op = pred.op || 'eq';
      if (op !== 'eq') continue;

      const { field, value } = pred;

      if (field === 'type') {
        const ids = this._store._index.get(value) || new Set();
        const est = ids.size;
        if (dryRun) return { strategy: 'index', field: 'type', value, estimatedCandidates: est };
        return { strategy: 'index', field: 'type', value, estimatedCandidates: est,
          candidates: this._store._messages.filter((m) => ids.has(m.id)) };
      }

      if (field === 'sender') {
        const ids = this._senderIndex.get(value) || new Set();
        const est = ids.size;
        if (dryRun) return { strategy: 'index', field: 'sender', value, estimatedCandidates: est };
        return { strategy: 'index', field: 'sender', value, estimatedCandidates: est,
          candidates: this._store._messages.filter((m) => ids.has(m.id)) };
      }

      if (field === 'synced') {
        const ids = this._syncedIndex.get(String(Boolean(value))) || new Set();
        const est = ids.size;
        if (dryRun) return { strategy: 'index', field: 'synced', value, estimatedCandidates: est };
        return { strategy: 'index', field: 'synced', value, estimatedCandidates: est,
          candidates: this._store._messages.filter((m) => ids.has(m.id)) };
      }
    }

    // Fall back to a full scan.
    const est = this._store._messages.length;
    if (dryRun) return { strategy: 'fullScan', estimatedCandidates: est };
    return { strategy: 'fullScan', estimatedCandidates: est,
      candidates: [...this._store._messages] };
  }

  /** Apply every predicate to a single message. @private */
  _applyAll(msg, predicates) {
    return predicates.every((pred) => this._applyOne(msg, pred));
  }

  /**
   * Evaluate a single predicate against a message.
   * @private
   */
  _applyOne(msg, pred) {
    const val = msg[pred.field];
    const target = pred.value;
    switch (pred.op || 'eq') {
      case 'eq':         return val === target;
      case 'ne':         return val !== target;
      case 'gt':         return val > target;
      case 'gte':        return val >= target;
      case 'lt':         return val < target;
      case 'lte':        return val <= target;
      case 'contains':   return typeof val === 'string' && val.includes(String(target));
      case 'startsWith': return typeof val === 'string' && val.startsWith(String(target));
      default:           return true; // unknown op → don't filter
    }
  }

  /** Names of all indexed fields (for documentation / introspection). */
  get indexedFields() {
    return ['type', 'sender', 'synced'];
  }
}

module.exports = QueryEngine;
