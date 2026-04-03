'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const AntiEntropy = require('../src/antientropy');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-ae-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeStore() {
  const fp = tmpFile();
  return { store: new Store(fp), filePath: fp };
}

describe('AntiEntropy', () => {
  let filePathA;
  let filePathB;

  afterEach(() => {
    [filePathA, filePathB].forEach((fp) => {
      try { if (fp) fs.unlinkSync(fp); } catch (_) { /* ignore */ }
    });
  });

  // ── digest ──────────────────────────────────────────────────────────────────
  test('digest returns empty array for empty store', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const ae = new AntiEntropy(store, 'node-A');
    const ids = await ae.digest();
    expect(ids).toEqual([]);
  });

  test('digest returns all message IDs', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    await store.save({ content: 'hello', sender: 'A' });
    await store.save({ content: 'world', sender: 'A' });
    const ae = new AntiEntropy(store, 'node-A');
    const ids = await ae.digest();
    expect(ids).toHaveLength(2);
  });

  // ── missing ─────────────────────────────────────────────────────────────────
  test('missing returns all messages when peer knows nothing', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    await store.save({ content: 'a', sender: 'A' });
    await store.save({ content: 'b', sender: 'A' });
    const ae = new AntiEntropy(store, 'node-A');
    const msgs = await ae.missing([]);
    expect(msgs).toHaveLength(2);
  });

  test('missing excludes IDs the peer already knows', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const m1 = await store.save({ content: 'known', sender: 'A' });
    const m2 = await store.save({ content: 'unknown', sender: 'A' });
    const ae = new AntiEntropy(store, 'node-A');
    const msgs = await ae.missing([m1.id]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m2.id);
  });

  test('missing returns empty when peer has everything', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const m = await store.save({ content: 'x', sender: 'A' });
    const ae = new AntiEntropy(store, 'node-A');
    const msgs = await ae.missing([m.id]);
    expect(msgs).toHaveLength(0);
  });

  // ── reconcile ───────────────────────────────────────────────────────────────
  test('reconcile ingests new messages into the store', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const ae = new AntiEntropy(store, 'node-A');
    const result = await ae.reconcile([
      { id: 'msg-1', content: 'hi', sender: 'B', type: 'general' },
      { id: 'msg-2', content: 'there', sender: 'B', type: 'general' },
    ]);
    expect(result.accepted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(store.size).toBe(2);
  });

  test('reconcile is idempotent (duplicate IDs are silently skipped)', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    await store.save({ id: 'dup-1', content: 'original', sender: 'A' });
    const ae = new AntiEntropy(store, 'node-A');
    // Re-ingesting the same message should not create a duplicate.
    await ae.reconcile([{ id: 'dup-1', content: 'original', sender: 'A', type: 'general' }]);
    expect(store.size).toBe(1);
  });

  test('reconcile skips invalid messages (missing content or sender)', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const ae = new AntiEntropy(store, 'node-A');
    const result = await ae.reconcile([
      { id: 'bad-1' },                        // no content, no sender
      { id: 'bad-2', content: 'x' },          // no sender
      { id: 'ok-1', content: 'hi', sender: 'B' },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.skipped).toBe(2);
  });

  test('reconcile emits "reconciled" event', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const ae = new AntiEntropy(store, 'node-A');
    const events = [];
    ae.on('reconciled', (e) => events.push(e));
    await ae.reconcile([{ id: 'x', content: 'hi', sender: 'B' }]);
    expect(events).toHaveLength(1);
    expect(events[0].accepted).toBe(1);
  });

  // ── syncWithPeer (transport mocked) ─────────────────────────────────────────
  test('syncWithPeer receives messages peer has and sends what peer lacks', async () => {
    const { store: storeA, filePath: fpA } = makeStore();
    const { store: storeB, filePath: fpB } = makeStore();
    filePathA = fpA;
    filePathB = fpB;

    // A has msg1; B has msg2.
    const msg1 = await storeA.save({ content: 'from A', sender: 'A' });
    const msg2 = await storeB.save({ content: 'from B', sender: 'B' });

    const aeA = new AntiEntropy(storeA, 'node-A');
    const aeB = new AntiEntropy(storeB, 'node-B');

    // Mock postJson: routes requests to the correct AntiEntropy instance.
    const mockPostJson = async (_ip, _port, urlPath, body) => {
      if (urlPath === '/api/reconcile') {
        const peerMissing = await aeB.missing(body.ids || []);
        const peerIds = await aeB.digest();
        return { missing: peerMissing, peerIds };
      }
      if (urlPath === '/api/push') {
        await aeB.reconcile(body.messages || []);
        return { accepted: (body.messages || []).length, skipped: 0 };
      }
      throw new Error(`Unknown path: ${urlPath}`);
    };

    const result = await aeA.syncWithPeer(
      { ip: '127.0.0.1', apiPort: 9999, nodeId: 'node-B' },
      mockPostJson
    );

    // A should have received msg2 from B.
    expect(result.received).toBe(1);
    expect(storeA.size).toBe(2);

    // B should have received msg1 from A (pushed in round 2).
    expect(result.sent).toBe(1);
    expect(storeB.size).toBe(2);
  });

  test('syncWithPeer emits sync:error on transport failure', async () => {
    const { store, filePath } = makeStore();
    filePathA = filePath;
    const ae = new AntiEntropy(store, 'node-A');
    const errors = [];
    ae.on('sync:error', (e) => errors.push(e));

    const failPostJson = async () => { throw new Error('network error'); };
    const result = await ae.syncWithPeer(
      { ip: '127.0.0.1', apiPort: 9999, nodeId: 'node-B' },
      failPostJson
    );

    expect(result.received).toBe(0);
    expect(result.sent).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
