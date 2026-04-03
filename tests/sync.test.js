'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');
const Store = require('../src/store');
const SyncEngine = require('../src/sync');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// Minimal fake store so we can test SyncEngine in isolation.
class FakeStore {
  constructor(messages = []) {
    this._messages = messages;
  }
  async getUnsynced() {
    return this._messages.filter((m) => !m.synced);
  }
  async markSynced(id) {
    const m = this._messages.find((m) => m.id === id);
    if (m) m.synced = true;
    return !!m;
  }
}

describe('SyncEngine', () => {
  test('isOnline starts as false', () => {
    const engine = new SyncEngine(new FakeStore());
    expect(engine.isOnline).toBe(false);
  });

  test('syncNow returns [] when remoteUrl is not configured', async () => {
    const engine = new SyncEngine(new FakeStore([{ id: '1', content: 'x', sender: 'a', synced: false }]));
    const results = await engine.syncNow();
    expect(results).toEqual([]);
  });

  test('syncNow marks messages as ok when remote server responds 200', async () => {
    // Start a tiny local HTTP server that accepts POSTs.
    const http = require('http');
    let received = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const fakeStore = new FakeStore([
      { id: 'msg-1', content: 'Hello', sender: 'Alice', synced: false },
      { id: 'msg-2', content: 'World', sender: 'Bob',   synced: false },
    ]);

    const engine = new SyncEngine(fakeStore, {
      remoteUrl: `http://127.0.0.1:${port}/sync`,
    });

    const results = await engine.syncNow();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(received).toBe(2);
    // All messages should now be marked synced in the store.
    expect(fakeStore._messages.every((m) => m.synced)).toBe(true);

    await new Promise((r) => server.close(r));
  });

  test('syncNow records error when remote returns non-200', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const fakeStore = new FakeStore([
      { id: 'msg-err', content: 'Fail', sender: 'X', synced: false },
    ]);
    const engine = new SyncEngine(fakeStore, {
      remoteUrl: `http://127.0.0.1:${port}/sync`,
    });

    const results = await engine.syncNow();
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBeTruthy();

    await new Promise((r) => server.close(r));
  });

  test('stop clears the timer and prevents further checks', () => {
    jest.useFakeTimers();
    const engine = new SyncEngine(new FakeStore(), { checkInterval: 1000 });
    engine.start();
    engine.stop();
    // After stop, advancing time should not trigger _check (no errors thrown).
    jest.advanceTimersByTime(5000);
    jest.useRealTimers();
  });
});
