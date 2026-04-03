'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const Compaction = require('../src/compaction');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-compact-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeStore() {
  const fp = tmpFile();
  return { store: new Store(fp), filePath: fp };
}

describe('Compaction', () => {
  let filePath;

  afterEach(() => {
    try { if (filePath) fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
  });

  // ── compact ──────────────────────────────────────────────────────────────────
  test('compact on empty store removes nothing', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    const cmp = new Compaction(store);
    const removed = await cmp.compact();
    expect(removed).toBe(0);
  });

  test('compact leaves raw (non-EventBus) messages untouched', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    await store.save({ content: 'plain text', sender: 'A' });
    await store.save({ content: 'another', sender: 'B' });
    const cmp = new Compaction(store);
    const removed = await cmp.compact();
    expect(removed).toBe(0);
    expect(store.size).toBe(2);
  });

  test('compact keeps only the latest version of each document', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;

    // Simulate two EventBus events for the same docId.
    const evtOld = {
      id: 'products:item-1',
      type: 'products',
      payload: { price: 10 },
      docId: 'item-1',
      lamport: 1,
      timestamp: new Date().toISOString(),
      sender: 'A',
    };
    const evtNew = {
      id: 'products:item-1-v2',
      type: 'products',
      payload: { price: 20 },
      docId: 'item-1',
      lamport: 5,
      timestamp: new Date().toISOString(),
      sender: 'A',
    };
    await store.save({ id: evtOld.id, content: JSON.stringify(evtOld), sender: 'A', type: 'products' });
    await store.save({ id: evtNew.id, content: JSON.stringify(evtNew), sender: 'A', type: 'products' });

    const cmp = new Compaction(store);
    const removed = await cmp.compact();
    expect(removed).toBe(1);
    expect(store.size).toBe(1);
    // The surviving message should be the one with the higher Lamport value.
    const surviving = store._messages[0];
    const evtParsed = JSON.parse(surviving.content);
    expect(evtParsed.payload.price).toBe(20);
  });

  test('compact keeps different docIds independently', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    const makeEvt = (docId, lamport, price) => ({
      id: `products:${docId}-${lamport}`,
      type: 'products',
      payload: { price },
      docId,
      lamport,
      timestamp: new Date().toISOString(),
      sender: 'A',
    });
    // Two different documents, each with two versions.
    const e1 = makeEvt('A', 1, 10);
    const e2 = makeEvt('A', 5, 15);
    const e3 = makeEvt('B', 2, 20);
    const e4 = makeEvt('B', 8, 25);
    for (const e of [e1, e2, e3, e4]) {
      await store.save({ id: e.id, content: JSON.stringify(e), sender: 'A', type: 'products' });
    }
    const cmp = new Compaction(store);
    const removed = await cmp.compact();
    expect(removed).toBe(2);
    expect(store.size).toBe(2);
  });

  test('compact never removes CRDT events', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    const evtOld = { id: 'crdt-1', type: 'crdt:orset', payload: {}, docId: 'list-1', lamport: 1, sender: 'A', timestamp: new Date().toISOString() };
    const evtNew = { id: 'crdt-2', type: 'crdt:orset', payload: {}, docId: 'list-1', lamport: 5, sender: 'A', timestamp: new Date().toISOString() };
    await store.save({ id: evtOld.id, content: JSON.stringify(evtOld), sender: 'A', type: 'crdt:orset' });
    await store.save({ id: evtNew.id, content: JSON.stringify(evtNew), sender: 'A', type: 'crdt:orset' });
    const cmp = new Compaction(store);
    const removed = await cmp.compact();
    expect(removed).toBe(0);
    expect(store.size).toBe(2);
  });

  test('compact emits compact:done event', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    const e1 = { id: 'p:a-1', type: 'p', payload: {}, docId: 'a', lamport: 1, sender: 'A', timestamp: new Date().toISOString() };
    const e2 = { id: 'p:a-2', type: 'p', payload: {}, docId: 'a', lamport: 2, sender: 'A', timestamp: new Date().toISOString() };
    await store.save({ id: e1.id, content: JSON.stringify(e1), sender: 'A', type: 'p' });
    await store.save({ id: e2.id, content: JSON.stringify(e2), sender: 'A', type: 'p' });
    const cmp = new Compaction(store);
    const events = [];
    cmp.on('compact:done', (e) => events.push(e));
    await cmp.compact();
    expect(events).toHaveLength(1);
    expect(events[0].removed).toBe(1);
  });

  // ── trim ─────────────────────────────────────────────────────────────────────
  test('trim: maxCount keeps only the most recent N messages', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    for (let i = 0; i < 5; i++) {
      await store.save({ content: `msg${i}`, sender: 'A' });
    }
    const cmp = new Compaction(store);
    const removed = await cmp.trim({ maxCount: 3 });
    expect(removed).toBe(2);
    expect(store.size).toBe(3);
  });

  test('trim: maxCount does not remove when within limit', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    await store.save({ content: 'a', sender: 'A' });
    await store.save({ content: 'b', sender: 'A' });
    const cmp = new Compaction(store);
    const removed = await cmp.trim({ maxCount: 5 });
    expect(removed).toBe(0);
    expect(store.size).toBe(2);
  });

  test('trim: maxAge removes old messages', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    // Insert a message with a very old timestamp.
    const old = {
      content: 'old',
      sender: 'A',
      timestamp: new Date(Date.now() - 10_000).toISOString(),
    };
    const fresh = { content: 'fresh', sender: 'A' };
    await store.save(old);
    await store.save(fresh);
    const cmp = new Compaction(store);
    const removed = await cmp.trim({ maxAge: 5_000 }); // 5 s
    expect(removed).toBe(1);
    expect(store.size).toBe(1);
  });

  test('trim: never removes CRDT events', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    // Add a bunch of regular messages + one CRDT event.
    for (let i = 0; i < 5; i++) {
      await store.save({ content: `m${i}`, sender: 'A' });
    }
    await store.save({ content: 'crdt-data', sender: 'A', type: 'crdt:gcounter' });
    const cmp = new Compaction(store);
    await cmp.trim({ maxCount: 2 });
    // CRDT event must still be there.
    const remaining = store._messages;
    expect(remaining.some((m) => m.type === 'crdt:gcounter')).toBe(true);
  });

  test('trim emits trim:done event', async () => {
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    for (let i = 0; i < 3; i++) await store.save({ content: `x${i}`, sender: 'A' });
    const cmp = new Compaction(store);
    const events = [];
    cmp.on('trim:done', (e) => events.push(e));
    await cmp.trim({ maxCount: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].removed).toBe(2);
  });

  // ── schedule / stop ──────────────────────────────────────────────────────────
  test('schedule and stop do not throw', () => {
    jest.useFakeTimers();
    const { store, filePath: fp } = makeStore();
    filePath = fp;
    const cmp = new Compaction(store);
    cmp.schedule(5000);
    jest.advanceTimersByTime(6000);
    cmp.stop();
    jest.useRealTimers();
  });
});
