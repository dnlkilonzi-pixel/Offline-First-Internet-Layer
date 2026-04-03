'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('../src/store');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('Store', () => {
  let store;
  let filePath;

  beforeEach(() => {
    filePath = tmpFile();
    store = new Store(filePath);
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(filePath + '.wal'); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(filePath + '.tmp'); } catch (_) { /* ignore */ }
  });

  test('saves a valid message and returns it', async () => {
    const msg = await store.save({ content: 'Hello world', sender: 'Alice' });
    expect(msg).toMatchObject({
      content: 'Hello world',
      sender: 'Alice',
      type: 'general',
      synced: false,
    });
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
  });

  test('rejects a message without content', async () => {
    await expect(store.save({ sender: 'Alice' })).rejects.toThrow();
  });

  test('rejects a message without sender', async () => {
    await expect(store.save({ content: 'Hi' })).rejects.toThrow();
  });

  test('getAll returns all messages most-recent first', async () => {
    await store.save({ content: 'First', sender: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ content: 'Second', sender: 'B' });
    const all = await store.getAll();
    expect(all.length).toBe(2);
    expect(all[0].content).toBe('Second');
    expect(all[1].content).toBe('First');
  });

  test('getUnsynced returns only unsynced messages', async () => {
    const m1 = await store.save({ content: 'A', sender: 'X' });
    const m2 = await store.save({ content: 'B', sender: 'X' });
    await store.markSynced(m1.id);

    const unsynced = await store.getUnsynced();
    expect(unsynced.map((m) => m.id)).toContain(m2.id);
    expect(unsynced.map((m) => m.id)).not.toContain(m1.id);
  });

  test('markSynced updates the synced flag', async () => {
    const msg = await store.save({ content: 'Test', sender: 'Y' });
    const found = await store.markSynced(msg.id);
    expect(found).toBe(true);

    const all = await store.getAll();
    expect(all.find((m) => m.id === msg.id).synced).toBe(true);
  });

  test('markSynced returns false for unknown id', async () => {
    const result = await store.markSynced('nonexistent-id');
    expect(result).toBe(false);
  });

  test('duplicate messages (same id) are stored only once', async () => {
    const base = { id: 'dup-1', content: 'Hi', sender: 'Z' };
    await store.save(base);
    await store.save(base);
    expect(store.size).toBe(1);
  });

  test('persists messages to disk and reloads them', async () => {
    await store.save({ content: 'Persist me', sender: 'P' });
    const store2 = new Store(filePath);
    const all = await store2.getAll();
    expect(all.length).toBe(1);
    expect(all[0].content).toBe('Persist me');
  });

  test('clear removes all messages', async () => {
    await store.save({ content: 'A', sender: 'A' });
    await store.clear();
    expect(store.size).toBe(0);
    const all = await store.getAll();
    expect(all).toEqual([]);
  });

  test('accepts custom message type', async () => {
    const msg = await store.save({ content: 'Exam Q1', sender: 'Teacher', type: 'exam' });
    expect(msg.type).toBe('exam');
  });

  test('getByType returns only messages of the specified type', async () => {
    await store.save({ content: 'chat 1', sender: 'A', type: 'chat' });
    await store.save({ content: 'chat 2', sender: 'B', type: 'chat' });
    await store.save({ content: 'system event', sender: 'sys', type: 'system' });
    const chatMsgs = store.getByType('chat');
    expect(chatMsgs).toHaveLength(2);
    expect(chatMsgs.every((m) => m.type === 'chat')).toBe(true);
  });

  test('getByType returns empty array for unknown type', () => {
    expect(store.getByType('nonexistent')).toEqual([]);
  });

  test('getByType returns messages in Lamport-descending order', async () => {
    await store.save({ content: 'first', sender: 'A', type: 'log' });
    await store.save({ content: 'second', sender: 'A', type: 'log' });
    const logs = store.getByType('log');
    expect(logs[0].content).toBe('second');
    expect(logs[1].content).toBe('first');
  });

  test('type index is correct after deleteMessages', async () => {
    const m1 = await store.save({ content: 'a', sender: 'A', type: 'log' });
    await store.save({ content: 'b', sender: 'A', type: 'log' });
    store.deleteMessages([m1.id]);
    expect(store.getByType('log')).toHaveLength(1);
  });
});
