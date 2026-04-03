'use strict';

/**
 * failureinject.js – Deterministic fault-injection for transport functions.
 *
 * Real distributed systems break under crash, delay, packet drop, and message
 * reordering.  This module provides pure, side-effect-free decorators that
 * wrap a `postJson(ip, port, path, payload)` transport function with
 * configurable fault behaviours.
 *
 * All decorators are composable:
 *   const faultyTransport = FailureInjector.compose(
 *     originalPostJson,
 *     (fn) => FailureInjector.delay(fn, 50),
 *     (fn) => FailureInjector.drop(fn, 0.3),
 *   );
 *
 * ── Fault modes ───────────────────────────────────────────────────────────────
 *   crash    – Every call throws immediately (node is unreachable).
 *   delay    – Each call is delayed by a fixed number of milliseconds before
 *              being forwarded to the original transport.
 *   drop     – Each call is dropped (throws) with a given probability.
 *              An optional deterministic RNG can be supplied for reproducible
 *              tests (e.g. a counter-based function).
 *   reorder  – Calls are buffered and replayed in reverse order once
 *              `bufferSize` calls have accumulated.  Partial buffers are
 *              flushed on flush().
 *
 * None of these decorators perform I/O themselves; they operate entirely
 * through the wrapped transport function.
 */

class FailureInjector {
  // ── Factory methods (each returns a wrapped postJson) ──────────────────────

  /**
   * Returns a transport that always throws, simulating a crashed or
   * unreachable node.
   *
   * @param {string} [message]
   * @returns {Function} transport → always throws
   */
  static crash(message = 'Node is unreachable (simulated crash)') {
    return async () => {
      throw new Error(message);
    };
  }

  /**
   * Wraps a transport with a fixed artificial latency.
   *
   * @param {Function} originalTransport
   * @param {number}   ms – Delay in milliseconds.
   * @returns {Function}
   */
  static delay(originalTransport, ms) {
    return async (...args) => {
      await new Promise((r) => setTimeout(r, ms));
      return originalTransport(...args);
    };
  }

  /**
   * Wraps a transport that randomly drops calls.
   * A dropped call throws `Error('Message dropped (simulated packet loss)')`.
   *
   * @param {Function} originalTransport
   * @param {number}   probability – 0..1; fraction of calls to drop.
   * @param {Function} [rng]       – Optional random number generator,
   *                                 defaults to Math.random.
   *                                 Pass a deterministic function for
   *                                 reproducible tests.
   * @returns {Function}
   */
  static drop(originalTransport, probability, rng = Math.random) {
    return async (...args) => {
      if (rng() < probability) {
        throw new Error('Message dropped (simulated packet loss)');
      }
      return originalTransport(...args);
    };
  }

  /**
   * Wraps a transport that buffers calls and delivers them in reverse order.
   *
   * Once `bufferSize` calls have accumulated they are flushed in reverse
   * order (last-in, first-out).  Calls that arrive while the buffer is
   * not yet full resolve immediately with `{}` (pretend sent).
   *
   * A `flush()` method is available on the returned function to drain any
   * remaining buffered calls in reverse order.
   *
   * @param {Function} originalTransport
   * @param {number}   [bufferSize=2]
   * @returns {Function & { flush: () => Promise<void> }}
   */
  static reorder(originalTransport, bufferSize = 2) {
    const buffer = [];

    const wrapped = async (...args) => {
      buffer.push(args);
      if (buffer.length >= bufferSize) {
        const batch = buffer.splice(0, bufferSize).reverse();
        let last;
        for (const callArgs of batch) {
          last = await originalTransport(...callArgs);
        }
        return last;
      }
      return {}; // buffered, pretend sent
    };

    // Allow tests to flush remaining buffered calls.
    wrapped.flush = async () => {
      const remaining = buffer.splice(0).reverse();
      for (const callArgs of remaining) {
        await originalTransport(...callArgs);
      }
    };

    return wrapped;
  }

  /**
   * Compose multiple fault wrappers left-to-right around an original transport.
   * Each wrapper receives the current (already-wrapped) transport and returns
   * a new one.
   *
   * @param {Function}   originalTransport
   * @param {...Function} wrappers – Each is (fn) => newFn
   * @returns {Function}
   *
   * @example
   * const faultyTransport = FailureInjector.compose(
   *   realPostJson,
   *   (fn) => FailureInjector.delay(fn, 10),
   *   (fn) => FailureInjector.drop(fn, 0.2),
   * );
   */
  static compose(originalTransport, ...wrappers) {
    return wrappers.reduce((fn, wrap) => wrap(fn), originalTransport);
  }
}

module.exports = FailureInjector;
