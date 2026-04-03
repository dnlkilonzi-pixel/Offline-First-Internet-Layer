'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const WAL = require('../src/wal');
const Store = require('../src/store');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-wal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('WAL', () => {
  let walPath;

  afterEach(() => {
    try { if (walPath) fs.unlinkSync(walPath); } catch (_) { /* ignore */ }
  });

  test('append writes an NDJSON entry', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    wal.append({ op: 'save', message: { id: '1', content: 'hi' } });
    const raw = fs.readFileSync(walPath, 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.op).toBe('save');
    expect(parsed.message.id).toBe('1');
  });

  test('append adds multiple entries on separate lines', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    wal.append({ op: 'save', message: { id: 'a' } });
    wal.append({ op: 'save', message: { id: 'b' } });
    const lines = fs.readFileSync(walPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  test('recover returns all appended entries in order', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    wal.append({ op: 'save', message: { id: '1' } });
    wal.append({ op: 'delete', ids: ['x'] });
    const entries = wal.recover();
    expect(entries).toHaveLength(2);
    expect(entries[0].op).toBe('save');
    expect(entries[1].op).toBe('delete');
    expect(entries[1].ids).toEqual(['x']);
  });

  test('recover returns empty array when WAL file does not exist', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    expect(wal.recover()).toEqual([]);
  });

  test('recover skips malformed lines and returns valid entries', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    fs.writeFileSync(walPath, '{"op":"save"}\n{CORRUPT}\n{"op":"delete","ids":[]}\n', 'utf8');
    const entries = wal.recover();
    // Corrupt line is silently skipped; the two valid lines are returned.
    expect(entries).toHaveLength(2);
    expect(entries[0].op).toBe('save');
    expect(entries[1].op).toBe('delete');
  });

  test('truncate empties the WAL file', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    wal.append({ op: 'save', message: { id: '1' } });
    wal.truncate();
    const content = fs.readFileSync(walPath, 'utf8');
    expect(content).toBe('');
  });

  test('truncate on non-existent WAL does not throw', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    expect(() => wal.truncate()).not.toThrow();
  });

  test('recover after truncate returns empty array', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    wal.append({ op: 'save', message: { id: '1' } });
    wal.truncate();
    expect(wal.recover()).toEqual([]);
  });

  test('path getter returns the WAL path', () => {
    walPath = tmpFile() + '.wal';
    const wal = new WAL(walPath);
    expect(wal.path).toBe(walPath);
  });
});

// ── WAL integration in Store ────────────────────────────────────────────────

describe('Store – WAL integration', () => {
  let filePath;
  let walPath;

  afterEach(() => {
    try { if (filePath) fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    try { if (walPath) fs.unlinkSync(walPath); } catch (_) { /* ignore */ }
    try { if (filePath) fs.unlinkSync(filePath + '.tmp'); } catch (_) { /* ignore */ }
  });

  test('WAL entry is written before snapshot on save', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'hello', sender: 'A' });
    // WAL should be empty after snapshot (truncated by snapshot())
    // because we call snapshot() explicitly. By default save() calls _persist() NOT snapshot().
    // So the WAL entry should still be there until snapshot() is called.
    const walEntries = new WAL(walPath).recover();
    expect(walEntries.some((e) => e.op === 'save')).toBe(true);
  });

  test('snapshot() truncates the WAL', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'hi', sender: 'A' });
    store.snapshot();
    const walEntries = new WAL(walPath).recover();
    expect(walEntries).toEqual([]);
  });

  test('WAL replay recovers messages after simulated crash (no snapshot)', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';

    // Manually write a WAL entry without creating a snapshot.
    const wal = new WAL(walPath);
    const msg = { id: 'crash-1', content: 'recovered', sender: 'A', type: 'general',
      timestamp: new Date().toISOString(), lamport: 1, synced: false };
    wal.append({ op: 'save', message: msg });

    // Create a Store on an empty snapshot file — it should replay the WAL.
    const store = new Store(filePath);
    expect(store.size).toBe(1);
    const all = await store.getAll();
    expect(all[0].id).toBe('crash-1');
  });

  test('WAL delete entries are replayed on recovery', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';

    // Write a snapshot with two messages, then add a WAL delete entry.
    const store = new Store(filePath);
    const m1 = await store.save({ content: 'keep', sender: 'A' });
    const m2 = await store.save({ content: 'delete-me', sender: 'A' });
    store.snapshot(); // truncate WAL (snapshot is current)

    // Simulate a crash after WAL delete but before snapshot.
    const wal = new WAL(walPath);
    wal.append({ op: 'delete', ids: [m2.id] });

    // New store should load snapshot + replay WAL delete.
    const store2 = new Store(filePath);
    expect(store2.size).toBe(1);
    expect(store2._messages[0].id).toBe(m1.id);
  });

  test('getByType returns messages of a given type', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'a', sender: 'A', type: 'chat' });
    await store.save({ content: 'b', sender: 'A', type: 'chat' });
    await store.save({ content: 'c', sender: 'A', type: 'system' });
    const chatMsgs = store.getByType('chat');
    expect(chatMsgs).toHaveLength(2);
    expect(chatMsgs.every((m) => m.type === 'chat')).toBe(true);
  });

  test('getByType returns empty array for unknown type', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    expect(store.getByType('nonexistent')).toEqual([]);
  });

  test('type index is rebuilt correctly after reload', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'x', sender: 'A', type: 'log' });
    store.snapshot();
    const store2 = new Store(filePath);
    expect(store2.getByType('log')).toHaveLength(1);
  });

  test('clear() also truncates the WAL', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'x', sender: 'A' });
    await store.clear();
    expect(store.size).toBe(0);
    expect(new WAL(walPath).recover()).toEqual([]);
  });

  test('deleteMessages() appends a WAL delete entry', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    const m = await store.save({ content: 'x', sender: 'A' });
    store.snapshot(); // start clean
    store.deleteMessages([m.id]);
    const walEntries = new WAL(walPath).recover();
    expect(walEntries.some((e) => e.op === 'delete')).toBe(true);
  });

  test('walPath getter returns correct path', () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    expect(store.walPath).toBe(walPath);
  });

  test('snapshot writes atomically (no .tmp file left behind)', async () => {
    filePath = tmpFile();
    walPath = filePath + '.wal';
    const store = new Store(filePath);
    await store.save({ content: 'x', sender: 'A' });
    store.snapshot();
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });
});
