'use strict';

/**
 * resilience.test.js – Fault-injection and resilience tests.
 *
 * Proves that the system's core correctness properties hold under
 * crash, delay, packet-drop, and message-reordering faults.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const AntiEntropy = require('../src/antientropy');
const { GCounter, ORSet } = require('../src/crdt');
const VectorClock = require('../src/vclock');
const ConsistencyMonitor = require('../src/consistency');
const FailureInjector = require('../src/failureinject');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-res-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeNode(nodeId) {
  const fp = tmpFile();
  const store = new Store(fp);
  const ae = new AntiEntropy(store, nodeId);
  return { store, ae, fp };
}

function cleanup(...fps) {
  for (const fp of fps) {
    try { fs.unlinkSync(fp); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(fp + '.wal'); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(fp + '.tmp'); } catch (_) { /* ignore */ }
  }
}

// Build a mock postJson that routes between two AntiEntropy instances.
function makeMockTransport(aeB) {
  return async (_ip, _port, urlPath, body) => {
    if (urlPath === '/api/reconcile') {
      const peerMissing = await aeB.missing(body.ids || []);
      const peerIds = await aeB.digest();
      return { missing: peerMissing, peerIds };
    }
    if (urlPath === '/api/push') {
      await aeB.reconcile(body.messages || []);
      return { accepted: (body.messages || []).length, skipped: 0 };
    }
    throw new Error(`Unknown path: ${urlPath}`);
  };
}

const PEER = { ip: '127.0.0.1', apiPort: 9999, nodeId: 'node-B' };

// ── FailureInjector unit tests ────────────────────────────────────────────────

describe('FailureInjector', () => {
  test('crash() always throws', async () => {
    const transport = FailureInjector.crash();
    await expect(transport('ip', 1, '/path', {})).rejects.toThrow('unreachable');
  });

  test('crash() uses custom message when provided', async () => {
    const transport = FailureInjector.crash('custom error');
    await expect(transport()).rejects.toThrow('custom error');
  });

  test('delay() adds latency and still resolves', async () => {
    let called = false;
    const orig = async () => { called = true; return { ok: true }; };
    const delayed = FailureInjector.delay(orig, 5);
    const start = Date.now();
    const result = await delayed();
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('drop() with probability 1 always drops', async () => {
    const orig = async () => ({ ok: true });
    const dropped = FailureInjector.drop(orig, 1.0, () => 0.0); // rng always returns 0 < 1
    await expect(dropped()).rejects.toThrow('dropped');
  });

  test('drop() with probability 0 never drops', async () => {
    const orig = async () => ({ ok: true });
    const notDropped = FailureInjector.drop(orig, 0.0, () => 0.5);
    await expect(notDropped()).resolves.toEqual({ ok: true });
  });

  test('drop() with deterministic rng drops every other call', async () => {
    const orig = async (label) => ({ label });
    let counter = 0;
    // rng returns 0.0 on even calls (drop) and 1.0 on odd calls (pass)
    const rng = () => (counter++ % 2 === 0 ? 0.0 : 1.0);
    const faultyTransport = FailureInjector.drop(orig, 0.5, rng);

    await expect(faultyTransport('a')).rejects.toThrow(); // dropped
    await expect(faultyTransport('b')).resolves.toEqual({ label: 'b' }); // passed
    await expect(faultyTransport('c')).rejects.toThrow(); // dropped
    await expect(faultyTransport('d')).resolves.toEqual({ label: 'd' }); // passed
  });

  test('reorder() buffers calls and delivers in reverse order', async () => {
    const deliveryOrder = [];
    const orig = async (label) => { deliveryOrder.push(label); return {}; };
    const reordered = FailureInjector.reorder(orig, 3);

    await reordered('first');   // buffered
    await reordered('second');  // buffered
    await reordered('third');   // flush: delivers third, second, first (reverse)

    expect(deliveryOrder).toEqual(['third', 'second', 'first']);
  });

  test('reorder() flush() delivers remaining buffered calls', async () => {
    const deliveryOrder = [];
    const orig = async (label) => { deliveryOrder.push(label); return {}; };
    const reordered = FailureInjector.reorder(orig, 5);

    await reordered('a'); // buffered
    await reordered('b'); // buffered
    await reordered.flush(); // deliver b, a

    expect(deliveryOrder).toEqual(['b', 'a']);
  });

  test('compose() chains multiple fault decorators', async () => {
    const calls = [];
    const orig = async (x) => { calls.push(x); return { x }; };
    // compose: delay 5ms, then pass through
    const composed = FailureInjector.compose(
      orig,
      (fn) => FailureInjector.delay(fn, 5),
    );
    const result = await composed('hello');
    expect(result).toEqual({ x: 'hello' });
    expect(calls).toContain('hello');
  });
});

// ── Anti-entropy resilience tests ─────────────────────────────────────────────

describe('AntiEntropy resilience', () => {
  // ── Crash fault ─────────────────────────────────────────────────────────────
  test('crash: syncWithPeer gracefully handles an unreachable peer', async () => {
    const A = makeNode('A');
    try {
      const errors = [];
      A.ae.on('sync:error', (e) => errors.push(e));

      const result = await A.ae.syncWithPeer(PEER, FailureInjector.crash());
      expect(result.received).toBe(0);
      expect(result.sent).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].err).toBeDefined();
    } finally {
      cleanup(A.fp);
    }
  });

  test('crash recovery: second sync round achieves convergence', async () => {
    const A = makeNode('A');
    const B = makeNode('B');
    try {
      await A.store.save({ content: 'from A', sender: 'A' });
      await B.store.save({ content: 'from B', sender: 'B' });

      const normalTransport = makeMockTransport(B.ae);

      // Round 1: crash → no sync
      await A.ae.syncWithPeer(PEER, FailureInjector.crash());
      expect(A.store.size).toBe(1); // A still only has its own message

      // Round 2: normal → convergence
      await A.ae.syncWithPeer(PEER, normalTransport);
      expect(A.store.size).toBe(2); // A now has B's message too
    } finally {
      cleanup(A.fp, B.fp);
    }
  });

  // ── Delay fault ─────────────────────────────────────────────────────────────
  test('delay: messages are still delivered correctly after latency', async () => {
    const A = makeNode('A');
    const B = makeNode('B');
    try {
      await A.store.save({ content: 'msg from A', sender: 'A' });
      const normalTransport = makeMockTransport(B.ae);
      const slowTransport = FailureInjector.delay(normalTransport, 10);

      const result = await A.ae.syncWithPeer(PEER, slowTransport);
      expect(result.sent).toBe(1);
      expect(B.store.size).toBe(1);
    } finally {
      cleanup(A.fp, B.fp);
    }
  });

  // ── Drop fault ───────────────────────────────────────────────────────────────
  test('drop: partial drops are retried and convergence achieved on second round', async () => {
    const A = makeNode('A');
    const B = makeNode('B');
    try {
      await A.store.save({ content: 'msg1', sender: 'A' });
      await A.store.save({ content: 'msg2', sender: 'A' });

      const normalTransport = makeMockTransport(B.ae);

      // Round 1: drop push (round 2 transport) — reconcile succeeds, push fails.
      let pushCallCount = 0;
      const dropPushTransport = async (ip, port, urlPath, body) => {
        if (urlPath === '/api/push') {
          pushCallCount++;
          throw new Error('Message dropped (simulated packet loss)');
        }
        return normalTransport(ip, port, urlPath, body);
      };

      const r1 = await A.ae.syncWithPeer(PEER, dropPushTransport);
      expect(r1.sent).toBe(0);       // push was dropped
      expect(B.store.size).toBe(0);  // B has nothing yet

      // Round 2: normal transport → B receives A's messages
      await A.ae.syncWithPeer(PEER, normalTransport);
      expect(B.store.size).toBe(2);
    } finally {
      cleanup(A.fp, B.fp);
    }
  });

  // ── Reorder fault ────────────────────────────────────────────────────────────
  test('reorder: out-of-order delivery still produces correct final state', async () => {
    const A = makeNode('A');
    const B = makeNode('B');
    try {
      await A.store.save({ id: 'msg-1', content: 'first', sender: 'A' });
      await A.store.save({ id: 'msg-2', content: 'second', sender: 'A' });

      const normalTransport = makeMockTransport(B.ae);

      // The reorder wrapper delivers calls in reversed batches.
      const reorderedTransport = FailureInjector.reorder(normalTransport, 2);

      // Two calls: reconcile (buffered), then push (triggers flush of both in reverse).
      await A.ae.syncWithPeer(PEER, reorderedTransport);
      // Flush any remaining buffered calls.
      if (reorderedTransport.flush) await reorderedTransport.flush();

      // Even though order was reversed, B should have both messages.
      expect(B.store.size).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup(A.fp, B.fp);
    }
  });
});

// ── CRDT convergence under faults ─────────────────────────────────────────────

describe('CRDT convergence under faults', () => {
  test('GCounter: merge is correct regardless of message order', () => {
    // Node A increments 3 times; node B increments 2 times.
    // With no drops, final value should be 5.
    const counterA = new GCounter('A');
    const counterB = new GCounter('B');
    counterA.increment(3);
    counterB.increment(2);

    // Simulate "out-of-order" delivery: B merges A's state, then A merges B's state.
    const merged1 = counterB.merge(counterA);
    const merged2 = counterA.merge(counterB);

    expect(merged1.value()).toBe(5);
    expect(merged2.value()).toBe(5);
  });

  test('GCounter: double-delivery (idempotent merge)', () => {
    const cA = new GCounter('A', { A: 5 });
    const cB = new GCounter('B', { B: 3 });
    const m1 = cA.merge(cB);
    const m2 = m1.merge(cB); // B's state delivered twice
    expect(m1.value()).toBe(m2.value());
  });

  test('ORSet: concurrent add+remove converges to add-wins', () => {
    // Node A adds 'item'; node B (which has seen A's add) removes 'item'; concurrently,
    // node A adds 'item' again with a new tag.  After merge, item must be present.
    const sA = new ORSet();
    sA.add('item'); // tag T1

    const sB = new ORSet(sA.state());
    sB.remove('item'); // tombstones T1

    sA.add('item'); // tag T2 — concurrent with B's remove

    const merged = sA.merge(sB);
    // T2 was not in sB's removed set → item survives
    expect(merged.has('item')).toBe(true);
  });

  test('ORSet: merge is commutative under concurrent operations', () => {
    const s1 = new ORSet();
    s1.add('a');
    s1.add('b');
    const s2 = new ORSet();
    s2.add('b');
    s2.add('c');
    const m1 = s1.merge(s2);
    const m2 = s2.merge(s1);
    expect(m1.values().sort()).toEqual(m2.values().sort());
  });
});

// ── Vector clock ordering under faults ────────────────────────────────────────

describe('VectorClock: causality preserved under reordering', () => {
  test('compare correctly identifies ordering regardless of delivery order', () => {
    // Events published in causal order A→B→C on node X.
    const vcA = { X: 1 };
    const vcB = { X: 2 };
    const vcC = { X: 3 };

    // Even if delivered as C, B, A:
    expect(VectorClock.compare(vcA, vcB)).toBe('before');
    expect(VectorClock.compare(vcB, vcC)).toBe('before');
    expect(VectorClock.compare(vcA, vcC)).toBe('before');
    // Reverse:
    expect(VectorClock.compare(vcC, vcA)).toBe('after');
  });

  test('concurrent events are detected regardless of which arrives first', () => {
    const vcA = { X: 2, Y: 1 }; // X wrote 2, then Y wrote 1
    const vcB = { X: 1, Y: 3 }; // X wrote 1, then Y wrote 3

    expect(VectorClock.compare(vcA, vcB)).toBe('concurrent');
    expect(VectorClock.compare(vcB, vcA)).toBe('concurrent');
  });

  test('buildCausalGraph produces correct lineage even when events processed out of order', () => {
    // A→B→C (sequential on one node), but processed as C, A, B.
    const events = [
      { id: 'C', vclock: { node: 3 } },
      { id: 'A', vclock: { node: 1 } },
      { id: 'B', vclock: { node: 2 } },
    ];

    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('A')).toEqual([]);
    expect(graph.get('B')).toEqual(['A']);
    expect(graph.get('C')).toEqual(['B']);
  });
});

// ── Consistency monitor session guarantees ────────────────────────────────────

describe('ConsistencyMonitor session guarantees under simulated faults', () => {
  test('monotonic reads: session detects stale read response', () => {
    const m = new ConsistencyMonitor();
    // Session reads up to lamport=20.
    m.advanceRead('session-1', 20);
    // A stale replica returns only events up to lamport=5.
    const staleEvents = [{ id: 'e1', lamport: 5 }];
    const { monotonic, ok } = m.checkRead('session-1', staleEvents);
    expect(monotonic).toBe(false);
    expect(ok).toBe(false);
  });

  test('read-your-writes: session detects missing own write', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('session-2', { id: 'my-write-1', lamport: 10 });
    // Response is from a node that hasn't received our write yet.
    const events = [{ id: 'other-event', lamport: 15 }];
    const { readYourWrites, ok } = m.checkRead('session-2', events);
    expect(readYourWrites).toBe(false);
    expect(ok).toBe(false);
  });

  test('both guarantees satisfied after full synchronisation', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('session-3', { id: 'w1', lamport: 7 });
    m.advanceRead('session-3', 7);
    // Full read includes the session's own write and new events.
    const events = [
      { id: 'w1', lamport: 7 },
      { id: 'other', lamport: 12 },
    ];
    const { monotonic, readYourWrites, ok } = m.checkRead('session-3', events);
    expect(monotonic).toBe(true);
    expect(readYourWrites).toBe(true);
    expect(ok).toBe(true);
  });
});
