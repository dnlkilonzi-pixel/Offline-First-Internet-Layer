'use strict';

const VectorClock = require('../src/vclock');

const { BEFORE, AFTER, CONCURRENT, EQUAL } = VectorClock.RELATIONS;

describe('VectorClock', () => {

  // ── Constructor ─────────────────────────────────────────────────────────────
  test('starts with empty state', () => {
    const vc = new VectorClock();
    expect(vc.get()).toEqual({});
  });

  test('can be seeded with initial state', () => {
    const vc = new VectorClock({ A: 3, B: 1 });
    expect(vc.get()).toEqual({ A: 3, B: 1 });
  });

  // ── increment ────────────────────────────────────────────────────────────────
  test('increment advances the specified node component', () => {
    const vc = new VectorClock();
    const snap = vc.increment('A');
    expect(snap).toEqual({ A: 1 });
    vc.increment('A');
    expect(vc.get()).toEqual({ A: 2 });
  });

  test('increment returns a snapshot, not a reference', () => {
    const vc = new VectorClock();
    const snap = vc.increment('A');
    vc.increment('A');
    expect(snap).toEqual({ A: 1 }); // snapshot is not updated
  });

  test('different nodes are tracked independently', () => {
    const vc = new VectorClock();
    vc.increment('A');
    vc.increment('B');
    vc.increment('A');
    expect(vc.get()).toEqual({ A: 2, B: 1 });
  });

  // ── update ───────────────────────────────────────────────────────────────────
  test('update merges by taking max per component', () => {
    const vc = new VectorClock({ A: 5, B: 1 });
    vc.update({ A: 3, B: 7, C: 2 });
    expect(vc.get()).toEqual({ A: 5, B: 7, C: 2 });
  });

  test('update returns snapshot after merge', () => {
    const vc = new VectorClock({ A: 1 });
    const snap = vc.update({ A: 4, B: 2 });
    expect(snap).toEqual({ A: 4, B: 2 });
  });

  // ── static compare ───────────────────────────────────────────────────────────
  test('compare: EQUAL for identical clocks', () => {
    expect(VectorClock.compare({ A: 1, B: 2 }, { A: 1, B: 2 })).toBe(EQUAL);
  });

  test('compare: EQUAL for two empty clocks', () => {
    expect(VectorClock.compare({}, {})).toBe(EQUAL);
  });

  test('compare: BEFORE when A is strictly less than B', () => {
    expect(VectorClock.compare({ A: 1 }, { A: 2 })).toBe(BEFORE);
  });

  test('compare: BEFORE when A has fewer components and all are ≤', () => {
    expect(VectorClock.compare({ A: 1 }, { A: 1, B: 1 })).toBe(BEFORE);
  });

  test('compare: AFTER when A is strictly greater than B', () => {
    expect(VectorClock.compare({ A: 3 }, { A: 1 })).toBe(AFTER);
  });

  test('compare: CONCURRENT when neither dominates', () => {
    expect(VectorClock.compare({ A: 2, B: 1 }, { A: 1, B: 3 })).toBe(CONCURRENT);
  });

  test('compare: handles missing components as 0', () => {
    expect(VectorClock.compare({ A: 1 }, { B: 1 })).toBe(CONCURRENT);
  });

  // ── buildCausalGraph ─────────────────────────────────────────────────────────
  test('empty event list produces empty graph', () => {
    const graph = VectorClock.buildCausalGraph([]);
    expect(graph.size).toBe(0);
  });

  test('single event has no parents', () => {
    const events = [{ id: 'e1', vclock: { A: 1 } }];
    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('e1')).toEqual([]);
  });

  test('sequential events: each has the previous as its direct parent', () => {
    // A: e1 → e2 → e3
    const events = [
      { id: 'e1', vclock: { A: 1 } },
      { id: 'e2', vclock: { A: 2 } },
      { id: 'e3', vclock: { A: 3 } },
    ];
    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('e1')).toEqual([]);
    expect(graph.get('e2')).toEqual(['e1']);
    expect(graph.get('e3')).toEqual(['e2']); // only direct parent
  });

  test('concurrent events have no causal relationship', () => {
    // A writes e1, B writes e2 independently
    const events = [
      { id: 'e1', vclock: { A: 1 } },
      { id: 'e2', vclock: { B: 1 } },
    ];
    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('e1')).toEqual([]);
    expect(graph.get('e2')).toEqual([]);
  });

  test('diamond pattern: merge event has two direct parents', () => {
    // e1 → e2 (A alone)
    // e1 → e3 (B alone, after seeing e1)
    // e4 merges e2 and e3
    const events = [
      { id: 'e1', vclock: { A: 1 } },
      { id: 'e2', vclock: { A: 2 } },
      { id: 'e3', vclock: { A: 1, B: 1 } },
      { id: 'e4', vclock: { A: 2, B: 1 } },
    ];
    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('e1')).toEqual([]);
    expect(graph.get('e2')).toEqual(['e1']);
    expect(graph.get('e3')).toEqual(['e1']);
    // e4's direct parents are e2 and e3 (not e1, which is transitive)
    expect(graph.get('e4').sort()).toEqual(['e2', 'e3'].sort());
  });

  test('transitive ancestors are pruned from direct parents', () => {
    // Chain: e1 → e2 → e3
    // e3's only direct parent should be e2, not e1
    const events = [
      { id: 'e1', vclock: { A: 1 } },
      { id: 'e2', vclock: { A: 2 } },
      { id: 'e3', vclock: { A: 3 } },
    ];
    const graph = VectorClock.buildCausalGraph(events);
    expect(graph.get('e3')).toEqual(['e2']);
    expect(graph.get('e3')).not.toContain('e1');
  });
});
