'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');
const Store = require('../src/store');
const LamportClock = require('../src/clock');
const EventBus = require('../src/eventbus');
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
  const { app, httpServer } = createServer({
    store,
    discovery,
    syncEngine,
    messenger: null,
    identity: opts.identity || null,
    router: opts.router || null,
    eventBus,
    connectivity: null,
  });
  return { app, httpServer, store, eventBus };
}

describe('HTTP API', () => {
  let filePath;
  let app;
  let httpServer;
  let store;
  let eventBus;

  beforeEach(() => {
    filePath = tmpFile();
    ({ app, httpServer, store, eventBus } = makeApp(filePath));
  });

  afterEach(async () => {
    await new Promise((r) => httpServer.close(r));
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
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
});

