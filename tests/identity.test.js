'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Identity = require('../src/identity');

function tmpKeyFile() {
  return path.join(os.tmpdir(), `ofil-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('Identity', () => {
  let keyFile;
  let identity;

  beforeEach(() => {
    keyFile = tmpKeyFile();
    identity = new Identity(keyFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(keyFile); } catch (_) { /* ignore */ }
  });

  test('generates a public key on first creation', () => {
    expect(identity.publicKeyHex).toBeTruthy();
    expect(identity.publicKeyHex).toHaveLength(64); // 32 bytes hex
  });

  test('persists the keypair and reloads it', () => {
    const hex1 = identity.publicKeyHex;
    const identity2 = new Identity(keyFile);
    expect(identity2.publicKeyHex).toBe(hex1);
  });

  test('different instances have different keys', () => {
    const keyFile2 = tmpKeyFile();
    const identity2 = new Identity(keyFile2);
    expect(identity2.publicKeyHex).not.toBe(identity.publicKeyHex);
    try { fs.unlinkSync(keyFile2); } catch (_) { /* ignore */ }
  });

  test('sign produces a 128-char hex string', () => {
    const fields = { id: '1', content: 'hi', sender: 'A', type: 'general', timestamp: '2026-01-01T00:00:00Z', lamport: 1 };
    const sig = identity.sign(fields);
    expect(sig).toHaveLength(128); // 64 bytes hex
  });

  test('verify returns true for a valid signature', () => {
    const fields = { id: '1', content: 'hello', sender: 'Alice', type: 'exam', timestamp: '2026-01-01T00:00:00Z', lamport: 5 };
    const sig = identity.sign(fields);
    const ok = Identity.verify(fields, sig, identity.publicKeyHex);
    expect(ok).toBe(true);
  });

  test('verify returns false when content is tampered', () => {
    const fields = { id: '1', content: 'hello', sender: 'Alice', type: 'exam', timestamp: '2026-01-01T00:00:00Z', lamport: 5 };
    const sig = identity.sign(fields);
    const tampered = { ...fields, content: 'evil content' };
    const ok = Identity.verify(tampered, sig, identity.publicKeyHex);
    expect(ok).toBe(false);
  });

  test('verify returns false for a wrong public key', () => {
    const fields = { id: '1', content: 'hi', sender: 'Bob', type: 'general', timestamp: '2026-01-01T00:00:00Z', lamport: 2 };
    const sig = identity.sign(fields);
    const keyFile2 = tmpKeyFile();
    const other = new Identity(keyFile2);
    const ok = Identity.verify(fields, sig, other.publicKeyHex);
    expect(ok).toBe(false);
    try { fs.unlinkSync(keyFile2); } catch (_) { /* ignore */ }
  });

  test('verify returns false for a garbage signature', () => {
    const fields = { id: '1', content: 'hi', sender: 'C', type: 'general', timestamp: '2026-01-01T00:00:00Z', lamport: 0 };
    const ok = Identity.verify(fields, 'deadbeef'.repeat(16), identity.publicKeyHex);
    expect(ok).toBe(false);
  });

  test('verify returns false for a garbage public key', () => {
    const fields = { id: '1', content: 'hi', sender: 'D', type: 'general', timestamp: '2026-01-01T00:00:00Z', lamport: 0 };
    const sig = identity.sign(fields);
    const ok = Identity.verify(fields, sig, 'badkey'.repeat(10).slice(0, 64));
    expect(ok).toBe(false);
  });
});
