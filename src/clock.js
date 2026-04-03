'use strict';

/**
 * clock.js – Lamport logical clock.
 *
 * A Lamport clock gives a total ordering to events across a distributed
 * system without relying on synchronised wall-clock time.
 *
 * Rules:
 *   1. Before generating a local event: tick() → increment and use.
 *   2. On receiving a remote event with timestamp T: update(T) → local = max(local, T) + 1.
 *   3. Events with the same Lamport value are concurrent; break the tie
 *      deterministically by message id to guarantee a total order.
 */

class LamportClock {
  /**
   * @param {number} [initial=0] – Seed value, used when reloading persisted state.
   */
  constructor(initial = 0) {
    this._time = initial;
  }

  /** Advance clock for a local event and return the new timestamp. */
  tick() {
    return ++this._time;
  }

  /**
   * Receive a remote timestamp and advance the local clock.
   * @param {number} remoteTime
   * @returns {number} New local time.
   */
  update(remoteTime) {
    this._time = Math.max(this._time, remoteTime) + 1;
    return this._time;
  }

  /** Current clock value (read-only). */
  get now() {
    return this._time;
  }

  /**
   * Deterministic comparator for two messages that carry Lamport timestamps.
   * Returns a negative, zero, or positive number (suitable for Array#sort).
   * Lower Lamport value = happened-before = sorts first (ascending).
   * Ties are broken by message id to guarantee a consistent total order.
   *
   * @param {{ lamport?: number, id?: string }} a
   * @param {{ lamport?: number, id?: string }} b
   * @returns {number}
   */
  static compare(a, b) {
    const la = a.lamport !== undefined ? a.lamport : 0;
    const lb = b.lamport !== undefined ? b.lamport : 0;
    if (la !== lb) return la - lb;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }
}

module.exports = LamportClock;
