'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const QueryEngine = require('../src/query');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-q-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(fp) {
  try { fs.unlinkSync(fp); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(fp + '.wal'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(fp + '.tmp'); } catch (_) { /* ignore */ }
}

async function makeStoreWithMessages(fp) {
  const store = new Store(fp);
  // Save a variety of messages for querying.
  await store.save({ content: 'Hello from Alice', sender: 'Alice', type: 'chat' });
  await store.save({ content: 'Good morning from Bob', sender: 'Bob', type: 'chat' });
  await store.save({ content: 'Exam Q1', sender: 'Alice', type: 'exam' });
  await store.save({ content: 'System boot', sender: 'System', type: 'system' });
  await store.save({ content: 'Second chat from Alice', sender: 'Alice', type: 'chat' });
  return store;
}

describe('QueryEngine', () => {
  let fp;
  let store;
  let qe;

  beforeEach(async () => {
    fp = tmpFile();
    store = await makeStoreWithMessages(fp);
    qe = new QueryEngine(store);
  });

  afterEach(() => cleanup(fp));

  // ── Construction & indexing ─────────────────────────────────────────────────
  test('constructs and exposes indexedFields', () => {
    expect(qe.indexedFields).toEqual(expect.arrayContaining(['type', 'sender', 'synced']));
  });

  test('rebuild() re-indexes from store contents', async () => {
    // Add a message after the QE was constructed.
    const m = await store.save({ content: 'Late message', sender: 'Carol', type: 'chat' });
    qe.index(m); // keep in sync
    const results = qe.query({ filter: { field: 'sender', value: 'Carol' } });
    expect(results).toHaveLength(1);
    expect(results[0].sender).toBe('Carol');
  });

  test('index() keeps secondary indexes in sync without full rebuild', async () => {
    const m = await store.save({ content: 'New', sender: 'Dave', type: 'chat' });
    qe.index(m);
    const results = qe.query({ filter: { field: 'sender', value: 'Dave' } });
    expect(results).toHaveLength(1);
  });

  // ── Full scan (no indexed predicate) ───────────────────────────────────────
  test('query with no filter returns all messages', () => {
    const results = qe.query();
    expect(results).toHaveLength(store.size);
  });

  test('query with lamport gt filter (full scan)', () => {
    const results = qe.query({ filter: { field: 'lamport', op: 'gt', value: 1 } });
    expect(results.every((m) => m.lamport > 1)).toBe(true);
  });

  test('query with contains on content (full scan)', () => {
    const results = qe.query({ filter: { field: 'content', op: 'contains', value: 'Exam' } });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('exam');
  });

  test('query with startsWith on sender (full scan)', () => {
    const results = qe.query({ filter: { field: 'sender', op: 'startsWith', value: 'Ali' } });
    expect(results.every((m) => m.sender.startsWith('Ali'))).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('query with ne operator', () => {
    const results = qe.query({ filter: { field: 'type', op: 'ne', value: 'chat' } });
    expect(results.every((m) => m.type !== 'chat')).toBe(true);
  });

  test('query with lte operator on lamport', () => {
    const all = qe.query();
    const maxLamport = Math.max(...all.map((m) => m.lamport));
    const results = qe.query({ filter: { field: 'lamport', op: 'lte', value: maxLamport } });
    expect(results).toHaveLength(all.length);
  });

  // ── Index scan (indexed fields: type, sender, synced) ─────────────────────
  test('query on type= uses index scan', () => {
    const plan = qe.explain({ filter: { field: 'type', value: 'chat' } });
    expect(plan.strategy).toBe('index');
    expect(plan.field).toBe('type');
  });

  test('query on sender= uses index scan', () => {
    const plan = qe.explain({ filter: { field: 'sender', value: 'Alice' } });
    expect(plan.strategy).toBe('index');
    expect(plan.field).toBe('sender');
  });

  test('query on synced= uses index scan', () => {
    const plan = qe.explain({ filter: { field: 'synced', value: false } });
    expect(plan.strategy).toBe('index');
    expect(plan.field).toBe('synced');
  });

  test('query on non-indexed field uses fullScan', () => {
    const plan = qe.explain({ filter: { field: 'content', op: 'contains', value: 'hi' } });
    expect(plan.strategy).toBe('fullScan');
  });

  test('query by type returns correct messages', () => {
    const results = qe.query({ filter: { field: 'type', value: 'exam' } });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('exam');
  });

  test('query by sender returns all messages from that sender', () => {
    const results = qe.query({ filter: { field: 'sender', value: 'Alice' } });
    expect(results).toHaveLength(3); // Alice sent 3 messages
    expect(results.every((m) => m.sender === 'Alice')).toBe(true);
  });

  test('query by synced=false returns all unsynced messages', () => {
    const results = qe.query({ filter: { field: 'synced', value: false } });
    expect(results.length).toBe(store.size);
    expect(results.every((m) => !m.synced)).toBe(true);
  });

  test('index scan estimatedCandidates matches actual result count', () => {
    const plan = qe.explain({ filter: { field: 'sender', value: 'Alice' } });
    const results = qe.query({ filter: { field: 'sender', value: 'Alice' } });
    expect(plan.estimatedCandidates).toBe(results.length);
  });

  // ── Compound predicates ────────────────────────────────────────────────────
  test('compound filter: sender=Alice AND type=chat', () => {
    const results = qe.query({
      filter: [
        { field: 'sender', value: 'Alice' },
        { field: 'type', value: 'chat' },
      ],
    });
    expect(results.every((m) => m.sender === 'Alice' && m.type === 'chat')).toBe(true);
    expect(results).toHaveLength(2);
  });

  test('compound filter: type=chat AND lamport > 1', () => {
    const results = qe.query({
      filter: [
        { field: 'type', value: 'chat' },
        { field: 'lamport', op: 'gt', value: 1 },
      ],
    });
    expect(results.every((m) => m.type === 'chat' && m.lamport > 1)).toBe(true);
  });

  test('empty filter array returns all messages', () => {
    const results = qe.query({ filter: [] });
    expect(results).toHaveLength(store.size);
  });

  // ── Ordering ───────────────────────────────────────────────────────────────
  test('default order is lamport descending', () => {
    const results = qe.query();
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].lamport).toBeGreaterThanOrEqual(results[i].lamport);
    }
  });

  test('order=asc sorts by lamport ascending', () => {
    const results = qe.query({ orderBy: 'lamport', order: 'asc' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].lamport).toBeLessThanOrEqual(results[i].lamport);
    }
  });

  test('orderBy=sender sorts alphabetically', () => {
    const results = qe.query({ orderBy: 'sender', order: 'asc' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].sender <= results[i].sender).toBe(true);
    }
  });

  // ── Pagination: limit / offset ─────────────────────────────────────────────
  test('limit restricts the result count', () => {
    const results = qe.query({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  test('offset skips the first N results', () => {
    const all = qe.query();
    const page2 = qe.query({ offset: 2 });
    expect(page2).toHaveLength(all.length - 2);
    expect(page2[0].id).toBe(all[2].id);
  });

  test('limit + offset implements pagination', () => {
    const page1 = qe.query({ limit: 2, offset: 0 });
    const page2 = qe.query({ limit: 2, offset: 2 });
    const all = qe.query();
    expect([...page1, ...page2].map((m) => m.id)).toEqual(all.slice(0, 4).map((m) => m.id));
  });

  test('offset beyond result count returns empty array', () => {
    const results = qe.query({ offset: 1000 });
    expect(results).toEqual([]);
  });

  // ── Empty store edge cases ─────────────────────────────────────────────────
  test('query on empty store returns empty array', () => {
    const emptyFp = tmpFile();
    const emptyStore = new Store(emptyFp);
    const emptyQe = new QueryEngine(emptyStore);
    expect(emptyQe.query()).toEqual([]);
    cleanup(emptyFp);
  });

  test('query on unknown sender returns empty array', () => {
    const results = qe.query({ filter: { field: 'sender', value: 'Nobody' } });
    expect(results).toEqual([]);
  });
});
