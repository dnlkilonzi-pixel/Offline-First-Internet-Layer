'use strict';

const LamportClock = require('../src/clock');

describe('LamportClock', () => {
  test('starts at 0', () => {
    const c = new LamportClock();
    expect(c.now).toBe(0);
  });

  test('tick increments and returns new value', () => {
    const c = new LamportClock();
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
    expect(c.now).toBe(2);
  });

  test('can be seeded with initial value', () => {
    const c = new LamportClock(10);
    expect(c.now).toBe(10);
    expect(c.tick()).toBe(11);
  });

  test('update takes max(local, remote) + 1 when remote > local', () => {
    const c = new LamportClock(3);
    const result = c.update(10);
    expect(result).toBe(11);
    expect(c.now).toBe(11);
  });

  test('update takes max(local, remote) + 1 when local > remote', () => {
    const c = new LamportClock(20);
    const result = c.update(5);
    expect(result).toBe(21);
    expect(c.now).toBe(21);
  });

  test('update takes max(local, remote) + 1 when equal', () => {
    const c = new LamportClock(5);
    const result = c.update(5);
    expect(result).toBe(6);
  });

  test('compare: lower lamport sorts first', () => {
    const a = { lamport: 1, id: 'a' };
    const b = { lamport: 5, id: 'b' };
    expect(LamportClock.compare(a, b)).toBeLessThan(0);
    expect(LamportClock.compare(b, a)).toBeGreaterThan(0);
  });

  test('compare: equal lamport breaks tie by id', () => {
    const a = { lamport: 3, id: 'aaa' };
    const b = { lamport: 3, id: 'bbb' };
    expect(LamportClock.compare(a, b)).toBeLessThan(0);
    expect(LamportClock.compare(b, a)).toBeGreaterThan(0);
  });

  test('compare: identical objects are equal', () => {
    const a = { lamport: 7, id: 'same' };
    expect(LamportClock.compare(a, a)).toBe(0);
  });

  test('compare: missing lamport treated as 0', () => {
    const a = { id: 'a' };          // lamport undefined → 0
    const b = { lamport: 1, id: 'b' };
    expect(LamportClock.compare(a, b)).toBeLessThan(0);
  });

  test('sort with compare produces deterministic total order', () => {
    const msgs = [
      { lamport: 3, id: 'c' },
      { lamport: 1, id: 'b' },
      { lamport: 3, id: 'a' },
      { lamport: 2, id: 'd' },
    ];
    const sorted = [...msgs].sort(LamportClock.compare);
    expect(sorted.map((m) => m.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
