'use strict';

/**
 * crdt.js – Conflict-free Replicated Data Types (CRDTs).
 *
 * CRDTs are data structures that can be independently modified on multiple
 * nodes and then merged deterministically — no coordination required.
 * They guarantee convergence: any two nodes that have received the same set
 * of updates will hold identical state.
 *
 * ── GCounter (grow-only counter) ────────────────────────────────────────────
 *   Each node owns a private counter partition.
 *   Increment: add to the local node's partition.
 *   Value:     sum of all partitions.
 *   Merge:     max per node partition.
 *
 *   Use-case: counting delivered messages, total bytes synced, vote tallies.
 *
 * ── ORSet (observed-remove set) ─────────────────────────────────────────────
 *   A set supporting both add and remove, with add-wins semantics:
 *   a concurrent add and remove of the same element leaves the element present.
 *
 *   Each add operation generates a unique tag (UUID).
 *   Remove marks all current tags of the element as "tombstoned".
 *   An element is in the set if it has ≥ 1 non-tombstoned tag.
 *   Merge: union of both the added-tags and the removed-tags sets.
 *
 *   Unlike last-write-wins registers, ORSets converge correctly under
 *   concurrent multi-writer edits without any coordination.
 *
 *   Use-case: shared shopping lists, collaborative tag clouds, peer membership.
 */

const crypto = require('crypto');

// ── GCounter ──────────────────────────────────────────────────────────────────

class GCounter {
  /**
   * @param {string} nodeId – This node's identifier (owns one partition).
   * @param {Object<string, number>} [state] – Existing state for rehydration.
   */
  constructor(nodeId, state = {}) {
    this._nodeId = nodeId;
    this._counts = { ...state };
  }

  /** Increment this node's counter partition by `amount` (default 1). */
  increment(amount = 1) {
    this._counts[this._nodeId] = (this._counts[this._nodeId] || 0) + amount;
  }

  /** The total value: sum across all node partitions. */
  value() {
    return Object.values(this._counts).reduce((sum, v) => sum + v, 0);
  }

  /** JSON-serialisable snapshot of all partitions. */
  state() {
    return { ...this._counts };
  }

  /**
   * Merge another GCounter into a new instance.
   * Result = max per node partition.  Neither input is mutated.
   * @param {GCounter} other
   * @returns {GCounter}
   */
  merge(other) {
    const merged = { ...this._counts };
    for (const [node, count] of Object.entries(other._counts)) {
      merged[node] = Math.max(merged[node] || 0, count);
    }
    return new GCounter(this._nodeId, merged);
  }

  /**
   * Static helper: merge two raw state objects.
   * @param {Object<string, number>} stateA
   * @param {Object<string, number>} stateB
   * @returns {Object<string, number>}
   */
  static mergeStates(stateA, stateB) {
    const result = { ...stateA };
    for (const [node, count] of Object.entries(stateB)) {
      result[node] = Math.max(result[node] || 0, count);
    }
    return result;
  }
}

// ── ORSet ─────────────────────────────────────────────────────────────────────

class ORSet {
  /**
   * @param {{ added?: Object<string, string[]>, removed?: Object<string, string[]> }} [state]
   *   Serialisable state for rehydration.  Tags are stored as plain arrays.
   */
  constructor(state = {}) {
    // _added / _removed: element → Set<tag-uuid>
    this._added = {};
    this._removed = {};
    for (const [el, tags] of Object.entries(state.added || {})) {
      this._added[el] = new Set(tags);
    }
    for (const [el, tags] of Object.entries(state.removed || {})) {
      this._removed[el] = new Set(tags);
    }
  }

  /**
   * Add an element to the set.
   * Generates a unique tag and returns it.
   * @param {string} element
   * @returns {string} The tag UUID for this specific add operation.
   */
  add(element) {
    const tag = crypto.randomUUID();
    if (!this._added[element]) this._added[element] = new Set();
    this._added[element].add(tag);
    return tag;
  }

  /**
   * Remove an element from the set by tombstoning all its current live tags.
   * Concurrent adds with tags not yet seen will survive this remove.
   * @param {string} element
   */
  remove(element) {
    if (!this._removed[element]) this._removed[element] = new Set();
    for (const tag of (this._added[element] || [])) {
      this._removed[element].add(tag);
    }
  }

  /**
   * Membership test: element is present iff it has ≥ 1 non-tombstoned tag.
   * @param {string} element
   * @returns {boolean}
   */
  has(element) {
    const added = this._added[element];
    if (!added || added.size === 0) return false;
    const removed = this._removed[element] || new Set();
    for (const tag of added) {
      if (!removed.has(tag)) return true;
    }
    return false;
  }

  /** All elements currently in the set. */
  values() {
    return Object.keys(this._added).filter((el) => this.has(el));
  }

  /**
   * JSON-serialisable state snapshot.
   * @returns {{ added: Object<string, string[]>, removed: Object<string, string[]> }}
   */
  state() {
    const result = { added: {}, removed: {} };
    for (const [el, tags] of Object.entries(this._added)) {
      result.added[el] = [...tags];
    }
    for (const [el, tags] of Object.entries(this._removed)) {
      result.removed[el] = [...tags];
    }
    return result;
  }

  /**
   * Merge another ORSet into a new instance: union of both added and removed sets.
   * Add-wins: a concurrent add and remove leaves the element present.
   * Neither input is mutated.
   * @param {ORSet} other
   * @returns {ORSet}
   */
  merge(other) {
    const newState = { added: {}, removed: {} };

    const allAdded = new Set([...Object.keys(this._added), ...Object.keys(other._added)]);
    for (const el of allAdded) {
      const tagsA = this._added[el] || new Set();
      const tagsB = other._added[el] || new Set();
      newState.added[el] = [...new Set([...tagsA, ...tagsB])];
    }

    const allRemoved = new Set([...Object.keys(this._removed), ...Object.keys(other._removed)]);
    for (const el of allRemoved) {
      const tagsA = this._removed[el] || new Set();
      const tagsB = other._removed[el] || new Set();
      newState.removed[el] = [...new Set([...tagsA, ...tagsB])];
    }

    return new ORSet(newState);
  }

  /**
   * Static helper: merge two raw state objects.
   * @param {{ added, removed }} stateA
   * @param {{ added, removed }} stateB
   * @returns {{ added, removed }}
   */
  static mergeStates(stateA, stateB) {
    return new ORSet(stateA).merge(new ORSet(stateB)).state();
  }
}

module.exports = { GCounter, ORSet };
