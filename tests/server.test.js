'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');
const Store = require('../src/store');
const LamportClock = require('../src/clock');
const EventBus = require('../src/eventbus');
const AntiEntropy = require('../src/antientropy');
const { createServer } = require('../src/server');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// Stub discovery with no peers.
class StubDiscovery {
  get peers() { return []; }
  get nodeId() { return 'test-node'; }
  on() {}
}

// Stub syncEngine with isOnline = false.
class StubSyncEngine {
  get isOnline() { return false; }
  async syncNow() { return []; }
  on() {}
}

function makeApp(filePath, opts = {}) {
  const store = new Store(filePath);
  const discovery = new StubDiscovery();
  const syncEngine = new StubSyncEngine();
  const eventBus = opts.eventBus !== false
    ? new EventBus(store, new LamportClock(), 'test-node')
    : undefined;
  const antientropy = opts.antientropy !== false
    ? new AntiEntropy(store, 'test-node')
    : undefined;
  const { app, httpServer } = createServer({
    store,
    discovery,
    syncEngine,
    messenger: null,
    identity: opts.identity || null,
    router: opts.router || null,
    eventBus,
    connectivity: null,
    antientropy,
  });
  return { app, httpServer, store, eventBus, antientropy };
}

describe('HTTP API', () => {
  let filePath;
  let app;
  let httpServer;
  let store;
  let eventBus;
  let antientropy;

  beforeEach(() => {
    filePath = tmpFile();
    ({ app, httpServer, store, eventBus, antientropy } = makeApp(filePath));
  });

  afterEach(async () => {
    await new Promise((r) => httpServer.close(r));
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(filePath + '.wal'); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(filePath + '.tmp'); } catch (_) { /* ignore */ }
  });

  // ── GET /api/status ────────────────────────────────────────────────────────
  test('GET /api/status returns online flag, tier and peers', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: false, peers: [], nodeId: 'test-node' });
  });

  // ── GET /api/identity ──────────────────────────────────────────────────────
  test('GET /api/identity returns 503 when identity not configured', async () => {
    const res = await request(app).get('/api/identity');
    expect(res.status).toBe(503);
  });

  // ── GET /api/messages ──────────────────────────────────────────────────────
  test('GET /api/messages returns empty array initially', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  // ── POST /api/messages ─────────────────────────────────────────────────────
  test('POST /api/messages creates a message with a lamport timestamp', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ content: 'Hello LAN', sender: 'Alice', type: 'general' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ content: 'Hello LAN', sender: 'Alice', synced: false });
    expect(res.body.id).toBeTruthy();
    expect(typeof res.body.lamport).toBe('number');
    expect(res.body.lamport).toBeGreaterThan(0);
  });

  test('POST /api/messages returns 400 when content is missing', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ sender: 'Alice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('POST /api/messages returns 400 when sender is missing', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ content: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('POST /api/messages supports exam type for school use-case', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ content: 'Q1: What is 2+2?', sender: 'Teacher', type: 'exam' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('exam');
  });

  test('GET /api/messages returns messages after posting', async () => {
    await request(app).post('/api/messages').send({ content: 'Msg1', sender: 'A' });
    await request(app).post('/api/messages').send({ content: 'Msg2', sender: 'B' });
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // ── POST /api/messages/receive ─────────────────────────────────────────────
  test('POST /api/messages/receive accepts peer message', async () => {
    const res = await request(app)
      .post('/api/messages/receive')
      .send({ id: 'peer-msg-1', content: 'Peer hello', sender: 'Peer-Device', type: 'general' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message.id).toBe('peer-msg-1');
  });

  test('POST /api/messages/receive returns verified: false when no signature provided', async () => {
    const res = await request(app)
      .post('/api/messages/receive')
      .send({ id: 'peer-msg-2', content: 'unsigned', sender: 'Peer', type: 'general' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
  });

  test('POST /api/messages/receive returns 400 for invalid payload', async () => {
    const res = await request(app)
      .post('/api/messages/receive')
      .send({ id: 'x' });
    expect(res.status).toBe(400);
  });

  // ── GET /api/peers ─────────────────────────────────────────────────────────
  test('GET /api/peers returns empty array', async () => {
    const res = await request(app).get('/api/peers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // ── POST /api/sync ─────────────────────────────────────────────────────────
  test('POST /api/sync returns results array', async () => {
    const res = await request(app).post('/api/sync');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  // ── EventBus endpoints ─────────────────────────────────────────────────────
  test('POST /api/events creates a typed event', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ type: 'inventory:update', payload: { item: 'pencils', count: 50 } });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('inventory:update');
    expect(res.body.payload).toEqual({ item: 'pencils', count: 50 });
    expect(typeof res.body.lamport).toBe('number');
  });

  test('POST /api/events returns 400 when type is missing', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ payload: {} });
    expect(res.status).toBe(400);
  });

  test('GET /api/events/:type returns event history', async () => {
    await request(app).post('/api/events').send({ type: 'log', payload: { msg: 'first' } });
    await request(app).post('/api/events').send({ type: 'log', payload: { msg: 'second' } });
    await request(app).post('/api/events').send({ type: 'other', payload: {} });
    const res = await request(app).get('/api/events/log');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  test('GET /api/docs/:type/:docId returns 404 for unknown doc', async () => {
    const res = await request(app).get('/api/docs/products/item-999');
    expect(res.status).toBe(404);
  });

  test('GET /api/docs/:type/:docId returns latest document state', async () => {
    await request(app).post('/api/events').send({
      type: 'products',
      payload: { name: 'Pencil', price: 10 },
      docId: 'item-1',
    });
    const res = await request(app).get('/api/docs/products/item-1');
    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ name: 'Pencil', price: 10 });
  });

  // ── Causal graph endpoint ───────────────────────────────────────────────────
  test('GET /api/events/:type/causal returns a causal graph object', async () => {
    await request(app).post('/api/events').send({ type: 'log', payload: { n: 1 } });
    await request(app).post('/api/events').send({ type: 'log', payload: { n: 2 } });
    const res = await request(app).get('/api/events/log/causal');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    // Each key is an event ID mapped to an array of parent IDs.
    for (const parents of Object.values(res.body)) {
      expect(Array.isArray(parents)).toBe(true);
    }
  });

  // ── Anti-entropy endpoints ─────────────────────────────────────────────────
  test('GET /api/digest returns an IDs array', async () => {
    await request(app).post('/api/messages').send({ content: 'hi', sender: 'A' });
    const res = await request(app).get('/api/digest');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.ids)).toBe(true);
    expect(res.body.ids).toHaveLength(1);
  });

  test('POST /api/reconcile returns missing messages and peer IDs', async () => {
    await request(app).post('/api/messages').send({ content: 'hi', sender: 'A' });
    const res = await request(app)
      .post('/api/reconcile')
      .send({ ids: [] }); // peer knows nothing
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.missing)).toBe(true);
    expect(res.body.missing).toHaveLength(1);
    expect(Array.isArray(res.body.peerIds)).toBe(true);
  });

  test('POST /api/reconcile returns nothing when peer is already up to date', async () => {
    const m = await store.save({ content: 'x', sender: 'A' });
    const res = await request(app)
      .post('/api/reconcile')
      .send({ ids: [m.id] });
    expect(res.status).toBe(200);
    expect(res.body.missing).toHaveLength(0);
  });

  test('POST /api/push ingests messages and returns accepted count', async () => {
    const res = await request(app)
      .post('/api/push')
      .send({ messages: [{ id: 'pushed-1', content: 'from peer', sender: 'B', type: 'general' }] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(store.size).toBe(1);
  });

  test('POST /api/push returns 503 when anti-entropy not configured', async () => {
    const fp2 = tmpFile();
    const { app: app2, httpServer: hs2 } = makeApp(fp2, { antientropy: false });
    const res = await request(app2).post('/api/push').send({ messages: [] });
    expect(res.status).toBe(503);
    await new Promise((r) => hs2.close(r));
    try { fs.unlinkSync(fp2); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(fp2 + '.wal'); } catch (_) { /* ignore */ }
  });

  // ── Consistency model endpoint ────────────────────────────────────────────
  test('GET /api/consistency returns the formal guarantee declaration', async () => {
    const res = await request(app).get('/api/consistency');
    expect(res.status).toBe(200);
    expect(res.body.guarantees).toBeDefined();
    expect(res.body.guarantees.model).toBeTruthy();
    expect(Array.isArray(res.body.guarantees.sessionGuarantees)).toBe(true);
  });

  // ── Snapshot endpoint ─────────────────────────────────────────────────────
  test('POST /api/snapshot returns ok:true', async () => {
    const res = await request(app).post('/api/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── Query engine endpoint ─────────────────────────────────────────────────
  test('GET /api/query returns results and plan', async () => {
    await store.save({ content: 'hello', sender: 'Alice', type: 'chat' });
    const res = await request(app).get('/api/query?type=chat');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.plan).toBeDefined();
    expect(res.body.plan.strategy).toBe('index');
  });

  test('GET /api/query with JSON q param works', async () => {
    await store.save({ content: 'test', sender: 'Bob', type: 'general' });
    const q = JSON.stringify({ filter: { field: 'sender', value: 'Bob' } });
    const res = await request(app).get(`/api/query?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    expect(res.body.results.every((m) => m.sender === 'Bob')).toBe(true);
  });

  test('GET /api/query with invalid JSON returns 400', async () => {
    const res = await request(app).get('/api/query?q=INVALID_JSON');
    expect(res.status).toBe(400);
  });

  test('GET /api/query with no filter returns all messages', async () => {
    await store.save({ content: 'a', sender: 'X', type: 'general' });
    await store.save({ content: 'b', sender: 'Y', type: 'general' });
    const res = await request(app).get('/api/query');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
  });

  // ── Benchmark endpoint ────────────────────────────────────────────────────
  test('GET /api/benchmark returns a report with write/read/antiEntropy/bandwidth', async () => {
    const res = await request(app).get('/api/benchmark?writeN=5&readN=3&aeN=3');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('write');
    expect(res.body).toHaveProperty('read');
    expect(res.body).toHaveProperty('antiEntropy');
    expect(res.body).toHaveProperty('bandwidth');
    expect(res.body.write.n).toBe(5);
  }, 15000);
});

