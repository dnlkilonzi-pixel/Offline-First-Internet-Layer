'use strict';

const ConsistencyMonitor = require('../src/consistency');

describe('ConsistencyMonitor', () => {

  // ── GUARANTEES ─────────────────────────────────────────────────────────────
  test('GUARANTEES is a non-null object', () => {
    expect(ConsistencyMonitor.GUARANTEES).toBeDefined();
    expect(typeof ConsistencyMonitor.GUARANTEES).toBe('object');
  });

  test('GUARANTEES declares the consistency model', () => {
    const g = ConsistencyMonitor.GUARANTEES;
    expect(g.model).toBeTruthy();
    expect(g.cap).toBeTruthy();
  });

  test('GUARANTEES declares session guarantees', () => {
    const { sessionGuarantees } = ConsistencyMonitor.GUARANTEES;
    expect(Array.isArray(sessionGuarantees)).toBe(true);
    expect(sessionGuarantees.some((s) => s.includes('Read Your Writes'))).toBe(true);
    expect(sessionGuarantees.some((s) => s.includes('Monotonic'))).toBe(true);
  });

  test('GUARANTEES declares conflict resolution strategies', () => {
    const { conflictResolution } = ConsistencyMonitor.GUARANTEES;
    expect(conflictResolution.documents).toBeTruthy();
    expect(conflictResolution.sets).toBeTruthy();
    expect(conflictResolution.counters).toBeTruthy();
  });

  test('GUARANTEES declares convergence and partition healing', () => {
    const g = ConsistencyMonitor.GUARANTEES;
    expect(g.convergence).toBeTruthy();
    expect(g.partitionHealing).toBeTruthy();
  });

  test('GUARANTEES declares store durability', () => {
    expect(ConsistencyMonitor.GUARANTEES.storeDurability).toBeTruthy();
  });

  test('GUARANTEES is frozen (immutable)', () => {
    expect(Object.isFrozen(ConsistencyMonitor.GUARANTEES)).toBe(true);
  });

  // ── Session initialisation ─────────────────────────────────────────────────
  test('starts with zero sessions', () => {
    const m = new ConsistencyMonitor();
    expect(m.sessionCount).toBe(0);
  });

  test('getSessionState returns null for unknown session', () => {
    const m = new ConsistencyMonitor();
    expect(m.getSessionState('s1')).toBeNull();
  });

  // ── registerWrite ──────────────────────────────────────────────────────────
  test('registerWrite creates a session and records the event', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'e1', lamport: 5 });
    const state = m.getSessionState('s1');
    expect(state).not.toBeNull();
    expect(state.pendingWrites).toBe(1);
    expect(state.highWatermark).toBe(5);
  });

  test('registerWrite advances the high-watermark to the highest lamport', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'e1', lamport: 3 });
    m.registerWrite('s1', { id: 'e2', lamport: 10 });
    m.registerWrite('s1', { id: 'e3', lamport: 7 });
    expect(m.getSessionState('s1').highWatermark).toBe(10);
  });

  // ── advanceRead ────────────────────────────────────────────────────────────
  test('advanceRead creates the session and sets the high-watermark', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s2', 15);
    const state = m.getSessionState('s2');
    expect(state.highWatermark).toBe(15);
    expect(state.pendingWrites).toBe(0);
  });

  test('advanceRead never decreases the high-watermark', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s1', 20);
    m.advanceRead('s1', 5); // should not go back
    expect(m.getSessionState('s1').highWatermark).toBe(20);
  });

  // ── checkRead: monotonic reads ─────────────────────────────────────────────
  test('checkRead: monotonic=true when events include at least one at watermark', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s1', 5);
    const events = [{ id: 'a', lamport: 3 }, { id: 'b', lamport: 6 }];
    const { monotonic } = m.checkRead('s1', events);
    expect(monotonic).toBe(true);
  });

  test('checkRead: monotonic=false when max lamport in set < session watermark', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s1', 20);
    // Only return older events — violates monotonic reads.
    const events = [{ id: 'x', lamport: 5 }];
    const { monotonic } = m.checkRead('s1', events);
    expect(monotonic).toBe(false);
  });

  test('checkRead: monotonic=true for empty event list (nothing to violate)', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s1', 10);
    const { monotonic } = m.checkRead('s1', []);
    expect(monotonic).toBe(true);
  });

  test('checkRead: monotonic=true for unknown session (no watermark)', () => {
    const m = new ConsistencyMonitor();
    const { monotonic } = m.checkRead('unknown', [{ id: 'x', lamport: 1 }]);
    expect(monotonic).toBe(true);
  });

  // ── checkRead: read your writes ────────────────────────────────────────────
  test('checkRead: readYourWrites=true when all pending writes are present', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'w1', lamport: 1 });
    m.registerWrite('s1', { id: 'w2', lamport: 2 });
    const events = [{ id: 'w1', lamport: 1 }, { id: 'w2', lamport: 2 }, { id: 'x', lamport: 3 }];
    const { readYourWrites } = m.checkRead('s1', events);
    expect(readYourWrites).toBe(true);
  });

  test('checkRead: readYourWrites=false when a pending write is not in the event set', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'w1', lamport: 1 });
    m.registerWrite('s1', { id: 'w2', lamport: 2 });
    // w2 is not returned by this read — RYW violated.
    const events = [{ id: 'w1', lamport: 1 }];
    const { readYourWrites } = m.checkRead('s1', events);
    expect(readYourWrites).toBe(false);
  });

  test('checkRead: ok=true only when both guarantees are satisfied', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'w1', lamport: 5 });
    const events = [{ id: 'w1', lamport: 5 }];
    const { ok, monotonic, readYourWrites } = m.checkRead('s1', events);
    expect(monotonic).toBe(true);
    expect(readYourWrites).toBe(true);
    expect(ok).toBe(true);
  });

  test('checkRead: ok=false when monotonic is violated', () => {
    const m = new ConsistencyMonitor();
    m.advanceRead('s1', 50);
    const events = [{ id: 'old', lamport: 1 }];
    const { ok } = m.checkRead('s1', events);
    expect(ok).toBe(false);
  });

  // ── destroySession ─────────────────────────────────────────────────────────
  test('destroySession removes the session', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('s1', { id: 'e1', lamport: 1 });
    m.destroySession('s1');
    expect(m.getSessionState('s1')).toBeNull();
    expect(m.sessionCount).toBe(0);
  });

  test('destroySession on unknown session does not throw', () => {
    const m = new ConsistencyMonitor();
    expect(() => m.destroySession('nonexistent')).not.toThrow();
  });

  // ── Session isolation ──────────────────────────────────────────────────────
  test('multiple sessions are tracked independently', () => {
    const m = new ConsistencyMonitor();
    m.registerWrite('alice', { id: 'a1', lamport: 10 });
    m.registerWrite('bob', { id: 'b1', lamport: 3 });
    expect(m.getSessionState('alice').highWatermark).toBe(10);
    expect(m.getSessionState('bob').highWatermark).toBe(3);
    expect(m.sessionCount).toBe(2);
  });
});
