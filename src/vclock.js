'use strict';

/**
 * vclock.js – Vector clock for causality tracking.
 *
 * A vector clock is a map of { nodeId → counter } that captures causal
 * relationships between events across distributed nodes:
 *
 *   happened-before (A → B): for all components, A[i] ≤ B[i], strict for ≥ 1
 *   concurrent       (A ∥ B): neither A → B nor B → A
 *
 * Vector clocks answer "what caused what?" — something Lamport clocks cannot.
 * They power:
 *   • Causal consistency   (deliver in causal order)
 *   • Conflict detection   (concurrent writes = true, resolvable conflicts)
 *   • Causal lineage graph (direct parent–child relationships between events)
 */

/** Relation labels returned by VectorClock.compare(). */
const RELATIONS = Object.freeze({
  BEFORE: 'before',
  AFTER: 'after',
  CONCURRENT: 'concurrent',
  EQUAL: 'equal',
});

class VectorClock {
  /**
   * @param {Object<string, number>} [state] – Initial clock state (for rehydration).
   */
  constructor(state = {}) {
    this._vc = { ...state };
  }

  /**
   * Increment this node's component and return a snapshot.
   * Call this before publishing a local event.
   * @param {string} nodeId
   * @returns {Object<string, number>} Snapshot after increment.
   */
  increment(nodeId) {
    this._vc[nodeId] = (this._vc[nodeId] || 0) + 1;
    return { ...this._vc };
  }

  /**
   * Merge a remote vector clock into this one (max per component).
   * Call this when receiving an event from a remote node.
   * @param {Object<string, number>} remoteVC
   * @returns {Object<string, number>} Snapshot after merge.
   */
  update(remoteVC) {
    for (const [node, time] of Object.entries(remoteVC || {})) {
      this._vc[node] = Math.max(this._vc[node] || 0, time);
    }
    return { ...this._vc };
  }

  /** Return a read-only snapshot of the current vector clock. */
  get() {
    return { ...this._vc };
  }

  // ── Static helpers ─────────────────────────────────────────────────────────

  /**
   * Compare two vector clock snapshots.
   *
   * @param {Object<string, number>} vcA
   * @param {Object<string, number>} vcB
   * @returns {'before'|'after'|'concurrent'|'equal'}
   */
  static compare(vcA, vcB) {
    const a = vcA || {};
    const b = vcB || {};
    const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);
    let aLtB = false;
    let bLtA = false;
    for (const node of allNodes) {
      const av = a[node] || 0;
      const bv = b[node] || 0;
      if (av < bv) aLtB = true;
      if (bv < av) bLtA = true;
    }
    if (!aLtB && !bLtA) return RELATIONS.EQUAL;
    if (aLtB && !bLtA) return RELATIONS.BEFORE;
    if (bLtA && !aLtB) return RELATIONS.AFTER;
    return RELATIONS.CONCURRENT;
  }

  /**
   * Build a direct-parent causal lineage graph from a list of events.
   *
   * Returns a Map<id, id[]> where each entry lists the IDs of the immediate
   * causal parents of that event: events E' such that E'.vclock → E.vclock
   * and no intermediate event exists causally between E' and E.
   *
   * Algorithm:
   *   For each event E, find all ancestors (events whose vclock happened-before
   *   E's vclock), then prune transitive ancestors — keeping only the "frontier"
   *   (events not dominated by any other ancestor).  These are the direct parents.
   *
   * Events without a vclock field are treated as having an empty vector clock
   * (they are concurrent with everything).
   *
   * @param {Array<{ id: string, vclock?: Object<string, number> }>} events
   * @returns {Map<string, string[]>}
   */
  static buildCausalGraph(events) {
    const graph = new Map();

    for (const evt of events) {
      const vcE = evt.vclock || {};

      // All events that happened strictly before evt.
      const ancestors = events.filter((e) => {
        if (e.id === evt.id) return false;
        return VectorClock.compare(e.vclock || {}, vcE) === RELATIONS.BEFORE;
      });

      // Keep only direct (non-transitive) parents: an ancestor A is a direct
      // parent of E if no other ancestor B exists such that A → B → E.
      const directParents = ancestors.filter((candidate) => {
        const vcC = candidate.vclock || {};
        return !ancestors.some((other) => {
          if (other.id === candidate.id) return false;
          const vcO = other.vclock || {};
          return (
            VectorClock.compare(vcC, vcO) === RELATIONS.BEFORE &&
            VectorClock.compare(vcO, vcE) === RELATIONS.BEFORE
          );
        });
      });

      graph.set(evt.id, directParents.map((e) => e.id));
    }

    return graph;
  }

  /** Relation constants (re-exported for callers). */
  static get RELATIONS() {
    return RELATIONS;
  }
}

module.exports = VectorClock;
