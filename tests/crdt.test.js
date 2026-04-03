'use strict';

const { GCounter, ORSet } = require('../src/crdt');

// ── GCounter ──────────────────────────────────────────────────────────────────
describe('GCounter', () => {
  test('starts at 0', () => {
    const c = new GCounter('A');
    expect(c.value()).toBe(0);
  });

  test('increment adds to the owning node partition', () => {
    const c = new GCounter('A');
    c.increment();
    c.increment(3);
    expect(c.value()).toBe(4);
    expect(c.state()).toEqual({ A: 4 });
  });

  test('different nodes have independent partitions', () => {
    const cA = new GCounter('A');
    const cB = new GCounter('B');
    cA.increment(5);
    cB.increment(3);
    // Before merging each counter only sees its own partition
    expect(cA.value()).toBe(5);
    expect(cB.value()).toBe(3);
  });

  test('merge: value is sum of max per node', () => {
    const cA = new GCounter('A', { A: 5, B: 2 });
    const cB = new GCounter('B', { A: 3, B: 7 });
    const merged = cA.merge(cB);
    expect(merged.value()).toBe(12); // max(5,3) + max(2,7) = 5 + 7
  });

  test('merge is commutative', () => {
    const cA = new GCounter('A', { A: 5, B: 2 });
    const cB = new GCounter('B', { A: 3, B: 7, C: 1 });
    expect(cA.merge(cB).value()).toBe(cB.merge(cA).value());
  });

  test('merge is idempotent', () => {
    const cA = new GCounter('A', { A: 5 });
    const merged1 = cA.merge(cA);
    const merged2 = merged1.merge(cA);
    expect(merged1.value()).toBe(merged2.value());
  });

  test('merge does not mutate either input', () => {
    const cA = new GCounter('A', { A: 2 });
    const cB = new GCounter('B', { B: 3 });
    cA.merge(cB);
    expect(cA.state()).toEqual({ A: 2 });
    expect(cB.state()).toEqual({ B: 3 });
  });

  test('static mergeStates works with plain objects', () => {
    const merged = GCounter.mergeStates({ A: 4, B: 1 }, { A: 2, B: 5, C: 3 });
    expect(merged).toEqual({ A: 4, B: 5, C: 3 });
  });

  test('can be rehydrated from state()', () => {
    const c = new GCounter('A');
    c.increment(7);
    const c2 = new GCounter('A', c.state());
    expect(c2.value()).toBe(7);
  });
});

// ── ORSet ─────────────────────────────────────────────────────────────────────
describe('ORSet', () => {
  test('starts empty', () => {
    const s = new ORSet();
    expect(s.values()).toEqual([]);
  });

  test('add: element becomes present', () => {
    const s = new ORSet();
    s.add('apple');
    expect(s.has('apple')).toBe(true);
    expect(s.values()).toContain('apple');
  });

  test('add returns a unique tag each time', () => {
    const s = new ORSet();
    const t1 = s.add('x');
    const t2 = s.add('x');
    expect(t1).not.toBe(t2);
  });

  test('remove: element is no longer present', () => {
    const s = new ORSet();
    s.add('apple');
    s.remove('apple');
    expect(s.has('apple')).toBe(false);
    expect(s.values()).not.toContain('apple');
  });

  test('remove on an unknown element is a no-op', () => {
    const s = new ORSet();
    expect(() => s.remove('ghost')).not.toThrow();
    expect(s.has('ghost')).toBe(false);
  });

  test('add-wins: concurrent add and remove keeps element present', () => {
    // Simulate: node A adds 'apple', node B removes (with A's tags), A adds again
    // The "concurrent" scenario is represented by merging two diverged replicas.
    const s1 = new ORSet();
    s1.add('apple');         // tag T1

    const s2 = new ORSet(s1.state()); // s2 starts as a copy of s1
    s2.remove('apple');       // removes T1 → apple should be gone in s2

    s1.add('apple');          // s1 adds apple again with tag T2 (concurrent with s2's remove)

    const merged = s1.merge(s2);
    // T2 was added after s2's remove; T2 is not in s2's removed set → apple is present
    expect(merged.has('apple')).toBe(true);
  });

  test('merge: union of elements', () => {
    const s1 = new ORSet();
    s1.add('apple');
    s1.add('banana');

    const s2 = new ORSet();
    s2.add('cherry');
    s2.add('banana');

    const merged = s1.merge(s2);
    expect(merged.values().sort()).toEqual(['apple', 'banana', 'cherry'].sort());
  });

  test('merge is commutative', () => {
    const s1 = new ORSet();
    s1.add('a');
    const s2 = new ORSet();
    s2.add('b');
    expect(s1.merge(s2).values().sort()).toEqual(s2.merge(s1).values().sort());
  });

  test('merge is idempotent', () => {
    const s = new ORSet();
    s.add('x');
    const merged = s.merge(s);
    expect(merged.values()).toEqual(s.values());
  });

  test('merge does not mutate either input', () => {
    const s1 = new ORSet();
    s1.add('a');
    const s2 = new ORSet();
    s2.add('b');
    s1.merge(s2);
    expect(s1.values()).not.toContain('b');
    expect(s2.values()).not.toContain('a');
  });

  test('can be rehydrated from state()', () => {
    const s = new ORSet();
    s.add('x');
    s.add('y');
    s.remove('x');
    const s2 = new ORSet(s.state());
    expect(s2.has('x')).toBe(false);
    expect(s2.has('y')).toBe(true);
  });

  test('static mergeStates works with plain state objects', () => {
    const s1 = new ORSet();
    s1.add('a');
    const s2 = new ORSet();
    s2.add('b');
    const merged = ORSet.mergeStates(s1.state(), s2.state());
    const result = new ORSet(merged);
    expect(result.values().sort()).toEqual(['a', 'b'].sort());
  });
});
