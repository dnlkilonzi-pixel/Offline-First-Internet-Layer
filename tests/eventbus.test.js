'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const LamportClock = require('../src/clock');
const EventBus = require('../src/eventbus');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-eb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeEventBus(nodeId = 'node-test') {
  const filePath = tmpFile();
  const store = new Store(filePath);
  const clock = new LamportClock();
  const bus = new EventBus(store, clock, nodeId);
  return { bus, store, clock, filePath };
}

describe('EventBus', () => {
  let filePath;

  afterEach(() => {
    try { if (filePath) fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
  });

  test('publish returns an event with correct shape', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    const event = await bus.publish('inventory:update', { item: 'pencils', count: 50 });
    expect(event.type).toBe('inventory:update');
    expect(event.payload).toEqual({ item: 'pencils', count: 50 });
    expect(event.lamport).toBeGreaterThan(0);
    expect(event.sender).toBe('node-test');
    expect(event.synced).toBe(false);
  });

  test('publish throws without a type', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    await expect(bus.publish('', {})).rejects.toThrow();
  });

  test('Lamport clock advances with each publish', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    const e1 = await bus.publish('msg', {});
    const e2 = await bus.publish('msg', {});
    expect(e2.lamport).toBeGreaterThan(e1.lamport);
  });

  test('emits the event type and generic event', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    const typed = [];
    const generic = [];
    bus.on('stock:low', (e) => typed.push(e));
    bus.on('event', (e) => generic.push(e));
    await bus.publish('stock:low', { item: 'chalk' });
    expect(typed).toHaveLength(1);
    expect(generic).toHaveLength(1);
  });

  // ── Document model ────────────────────────────────────────────────────────

  test('doc() returns null before any publish', () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    expect(bus.doc('products', 'item-1')).toBeNull();
  });

  test('doc() returns the latest event payload for a docId', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    await bus.publish('products', { name: 'Pencil', price: 10 }, { docId: 'item-1' });
    const doc = bus.doc('products', 'item-1');
    expect(doc).not.toBeNull();
    expect(doc.payload).toEqual({ name: 'Pencil', price: 10 });
  });

  test('doc() reflects the most recent publish (last-write-wins)', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    await bus.publish('products', { name: 'Pencil', price: 10 }, { docId: 'item-1' });
    await bus.publish('products', { name: 'Pencil', price: 12 }, { docId: 'item-1' });
    const doc = bus.doc('products', 'item-1');
    expect(doc.payload.price).toBe(12);
  });

  // ── ingest (conflict resolution) ──────────────────────────────────────────

  test('ingest accepts an event with a higher lamport', async () => {
    const { bus, clock, filePath: fp } = makeEventBus('node-A');
    filePath = fp;
    // Publish a local version at lamport 1.
    await bus.publish('products', { price: 10 }, { docId: 'p1' });

    // Ingest a peer event with higher lamport (wins).
    const peerEvent = {
      id: 'products:p1',
      type: 'products',
      payload: { price: 20 },
      docId: 'p1',
      lamport: 100,
      timestamp: new Date().toISOString(),
      sender: 'node-B',
      synced: false,
    };
    const { accepted } = await bus.ingest(peerEvent);
    expect(accepted).toBe(true);
    expect(bus.doc('products', 'p1').payload.price).toBe(20);
  });

  test('ingest rejects an event with a lower lamport (current wins)', async () => {
    const { bus, filePath: fp } = makeEventBus('node-A');
    filePath = fp;
    // Publish local version with a high lamport.
    const peerFirst = {
      id: 'products:p2',
      type: 'products',
      payload: { price: 50 },
      docId: 'p2',
      lamport: 100,
      timestamp: new Date().toISOString(),
      sender: 'node-B',
      synced: false,
    };
    await bus.ingest(peerFirst);

    // Now try to ingest an older event (lower lamport).
    const olderEvent = {
      id: 'products:p2',
      type: 'products',
      payload: { price: 5 },
      docId: 'p2',
      lamport: 1,
      timestamp: new Date().toISOString(),
      sender: 'node-C',
      synced: false,
    };
    const { accepted } = await bus.ingest(olderEvent);
    expect(accepted).toBe(false);
    // doc still holds the higher-lamport value
    expect(bus.doc('products', 'p2').payload.price).toBe(50);
  });

  test('ingest emits conflict event when rejecting', async () => {
    const { bus, filePath: fp } = makeEventBus('node-A');
    filePath = fp;
    const conflicts = [];
    bus.on('conflict', (incoming, retained) => conflicts.push({ incoming, retained }));

    // Establish a document with high lamport.
    await bus.ingest({
      id: 'docs:x',
      type: 'docs',
      payload: { v: 'high' },
      docId: 'x',
      lamport: 50,
      timestamp: new Date().toISOString(),
      sender: 'node-B',
      synced: false,
    });

    // Ingest older event → should be rejected and emit conflict.
    await bus.ingest({
      id: 'docs:x',
      type: 'docs',
      payload: { v: 'low' },
      docId: 'x',
      lamport: 2,
      timestamp: new Date().toISOString(),
      sender: 'node-C',
      synced: false,
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].incoming.payload.v).toBe('low');
    expect(conflicts[0].retained.payload.v).toBe('high');
  });

  // ── history ───────────────────────────────────────────────────────────────

  test('history returns events of a type in Lamport order', async () => {
    const { bus, filePath: fp } = makeEventBus();
    filePath = fp;
    await bus.publish('log', { msg: 'first' });
    await bus.publish('log', { msg: 'second' });
    await bus.publish('other', { msg: 'noise' });
    const hist = await bus.history('log');
    expect(hist).toHaveLength(2);
    expect(hist[0].payload.msg).toBe('first');
    expect(hist[1].payload.msg).toBe('second');
  });
});
