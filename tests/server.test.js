'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');
const Store = require('../src/store');
const Discovery = require('../src/discovery');
const { Messenger } = require('../src/messenger');
const SyncEngine = require('../src/sync');
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

function makeApp(filePath) {
  const store = new Store(filePath);
  const discovery = new StubDiscovery();
  const syncEngine = new StubSyncEngine();
  const { app, httpServer } = createServer({ store, discovery, syncEngine, messenger: null });
  return { app, httpServer, store };
}

describe('HTTP API', () => {
  let filePath;
  let app;
  let httpServer;
  let store;

  beforeEach(() => {
    filePath = tmpFile();
    ({ app, httpServer, store } = makeApp(filePath));
  });

  afterEach(async () => {
    await new Promise((r) => httpServer.close(r));
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
  });

  // ── GET /api/status ────────────────────────────────────────────────────────
  test('GET /api/status returns online flag and peers', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: false, peers: [], nodeId: 'test-node' });
  });

  // ── GET /api/messages ──────────────────────────────────────────────────────
  test('GET /api/messages returns empty array initially', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  // ── POST /api/messages ─────────────────────────────────────────────────────
  test('POST /api/messages creates a message', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ content: 'Hello LAN', sender: 'Alice', type: 'general' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ content: 'Hello LAN', sender: 'Alice', synced: false });
    expect(res.body.id).toBeTruthy();
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
});
