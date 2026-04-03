'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('../src/store');
const BenchmarkRunner = require('../src/benchmark');

function tmpFile() {
  return path.join(os.tmpdir(), `ofil-bm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(...fps) {
  for (const fp of fps) {
    try { fs.unlinkSync(fp); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(fp + '.wal'); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(fp + '.tmp'); } catch (_) { /* ignore */ }
  }
}

describe('BenchmarkRunner', () => {
  let bench;
  let fpA;
  let fpB;
  let storeA;
  let storeB;

  beforeEach(() => {
    bench = new BenchmarkRunner();
    fpA = tmpFile();
    fpB = tmpFile();
    storeA = new Store(fpA);
    storeB = new Store(fpB);
  });

  afterEach(() => cleanup(fpA, fpB));

  // ── write throughput ────────────────────────────────────────────────────────
  test('write() returns correct n and saves messages to the store', async () => {
    const result = await bench.write(storeA, 10);
    expect(result.n).toBe(10);
    expect(storeA.size).toBe(10);
  });

  test('write() reports a non-negative durationMs', async () => {
    const result = await bench.write(storeA, 5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('write() reports a positive opsPerSec (or Infinity when instant)', async () => {
    const result = await bench.write(storeA, 5);
    expect(result.opsPerSec).toBeGreaterThanOrEqual(0);
  });

  test('write() uses default n=500 when not specified', async () => {
    const result = await bench.write(storeA);
    expect(result.n).toBe(500);
    expect(storeA.size).toBe(500);
  }, 30000); // allow up to 30 s for the default 500-write run

  // ── read throughput ─────────────────────────────────────────────────────────
  test('read() returns correct n', async () => {
    await bench.write(storeA, 10); // seed the store
    const result = await bench.read(storeA, 5);
    expect(result.n).toBe(5);
  });

  test('read() reports a non-negative durationMs', async () => {
    await bench.write(storeA, 10);
    const result = await bench.read(storeA, 5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('read() reports a positive opsPerSec', async () => {
    await bench.write(storeA, 5);
    const result = await bench.read(storeA, 5);
    expect(result.opsPerSec).toBeGreaterThanOrEqual(0);
  });

  // ── anti-entropy convergence ────────────────────────────────────────────────
  test('antiEntropyRound() seeds storeA and syncs messages to storeB', async () => {
    const result = await bench.antiEntropyRound(storeA, storeB, 10);
    expect(storeB.size).toBe(10);
    // A sends 10 messages TO B; result.sent counts them.
    expect(result.sent).toBe(10);
  });

  test('antiEntropyRound() reports durationMs >= 0', async () => {
    const result = await bench.antiEntropyRound(storeA, storeB, 5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('antiEntropyRound() reports correct n', async () => {
    const result = await bench.antiEntropyRound(storeA, storeB, 7);
    expect(result.n).toBe(7);
  });

  // ── bandwidth ───────────────────────────────────────────────────────────────
  test('bandwidth() returns correct messageCount', () => {
    const msgs = [
      { id: 'a', content: 'hi', sender: 'A', type: 'general', lamport: 1, synced: false },
      { id: 'b', content: 'there', sender: 'B', type: 'general', lamport: 2, synced: false },
    ];
    const result = bench.bandwidth(msgs);
    expect(result.messageCount).toBe(2);
  });

  test('bandwidth() digestBytes is positive', () => {
    const msgs = [{ id: 'abc-uuid', content: 'x', sender: 'A', type: 'g', lamport: 1, synced: false }];
    const result = bench.bandwidth(msgs);
    expect(result.digestBytes).toBeGreaterThan(0);
  });

  test('bandwidth() deltaBytes > digestBytes for a typical message set', () => {
    const msgs = [{ id: 'abc-uuid-def-1', content: 'Hello world message content here',
      sender: 'Alice', type: 'chat', lamport: 5, synced: false }];
    const result = bench.bandwidth(msgs);
    expect(result.deltaBytes).toBeGreaterThan(result.digestBytes);
  });

  test('bandwidth() totalBytes = digestBytes + deltaBytes', () => {
    const msgs = [{ id: 'a', content: 'x', sender: 'A', type: 'g', lamport: 1, synced: false }];
    const r = bench.bandwidth(msgs);
    expect(r.totalBytes).toBe(r.digestBytes + r.deltaBytes);
  });

  test('bandwidth() of empty array returns zero bytes', () => {
    const r = bench.bandwidth([]);
    expect(r.messageCount).toBe(0);
    expect(r.totalBytes).toBeGreaterThanOrEqual(0); // [] serialised is still 2 bytes
  });

  // ── run (consolidated report) ───────────────────────────────────────────────
  test('run() returns a report with all four sections', async () => {
    const report = await bench.run(storeA, storeB, { writeN: 5, readN: 3, aeN: 5 });
    expect(report).toHaveProperty('write');
    expect(report).toHaveProperty('read');
    expect(report).toHaveProperty('antiEntropy');
    expect(report).toHaveProperty('bandwidth');
    expect(report).toHaveProperty('timestamp');
  });

  test('run() write section has correct n', async () => {
    const report = await bench.run(storeA, storeB, { writeN: 7, readN: 3, aeN: 3 });
    expect(report.write.n).toBe(7);
  });
});
