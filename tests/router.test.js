'use strict';

const Router = require('../src/router');

describe('Router', () => {
  const NODE = 'node-A';
  let router;

  beforeEach(() => {
    router = new Router(NODE);
  });

  // ── shouldAccept ──────────────────────────────────────────────────────────

  test('accepts a message that has not visited this node', () => {
    expect(router.shouldAccept({ hops: ['node-B', 'node-C'] })).toBe(true);
  });

  test('rejects a message already in hops (loop prevention)', () => {
    expect(router.shouldAccept({ hops: [NODE, 'node-B'] })).toBe(false);
  });

  test('accepts a message with no hops field', () => {
    expect(router.shouldAccept({})).toBe(true);
  });

  // ── shouldForward ─────────────────────────────────────────────────────────

  test('forwards when ttl > 0 and not in hops', () => {
    expect(router.shouldForward({ ttl: 3, hops: [] })).toBe(true);
  });

  test('does not forward when ttl === 0', () => {
    expect(router.shouldForward({ ttl: 0, hops: [] })).toBe(false);
  });

  test('does not forward when this node is already in hops', () => {
    expect(router.shouldForward({ ttl: 3, hops: [NODE] })).toBe(false);
  });

  test('uses DEFAULT_TTL when ttl field is missing', () => {
    expect(router.shouldForward({ hops: [] })).toBe(true);
  });

  // ── prepareForward ────────────────────────────────────────────────────────

  test('decrements ttl by 1', () => {
    const fwd = router.prepareForward({ ttl: 4, hops: ['node-B'] });
    expect(fwd.ttl).toBe(3);
  });

  test('appends this nodeId to hops', () => {
    const fwd = router.prepareForward({ ttl: 4, hops: ['node-B'] });
    expect(fwd.hops).toEqual(['node-B', NODE]);
  });

  test('does not mutate the original message', () => {
    const msg = { ttl: 4, hops: ['node-B'], content: 'hello' };
    router.prepareForward(msg);
    expect(msg.hops).toEqual(['node-B']);
    expect(msg.ttl).toBe(4);
  });

  test('initialises hops to [nodeId] when hops is missing', () => {
    const fwd = router.prepareForward({ ttl: 3 });
    expect(fwd.hops).toEqual([NODE]);
  });

  // ── selectPeers ───────────────────────────────────────────────────────────

  test('returns all peers when hops is empty', () => {
    const peers = [{ nodeId: 'B' }, { nodeId: 'C' }];
    expect(router.selectPeers(peers, { hops: [] })).toEqual(peers);
  });

  test('excludes peers already in hops', () => {
    const peers = [{ nodeId: 'B' }, { nodeId: 'C' }, { nodeId: 'D' }];
    const selected = router.selectPeers(peers, { hops: ['B', 'D'] });
    expect(selected).toEqual([{ nodeId: 'C' }]);
  });

  test('returns empty array when all peers are in hops', () => {
    const peers = [{ nodeId: 'B' }, { nodeId: 'C' }];
    const selected = router.selectPeers(peers, { hops: ['B', 'C'] });
    expect(selected).toEqual([]);
  });

  // ── stampOrigin ───────────────────────────────────────────────────────────

  test('stamps a message with default ttl and empty hops', () => {
    const msg = { id: '1', content: 'hi', sender: 'A' };
    const stamped = router.stampOrigin(msg);
    expect(stamped.ttl).toBe(Router.DEFAULT_TTL);
    expect(stamped.hops).toEqual([]);
    expect(stamped.content).toBe('hi'); // original fields preserved
  });

  test('does not mutate the original message', () => {
    const msg = { id: '1', content: 'hi' };
    router.stampOrigin(msg);
    expect(msg.ttl).toBeUndefined();
  });

  // ── end-to-end gossip simulation ──────────────────────────────────────────

  test('message reaches 3 hops then stops', () => {
    const routers = ['A', 'B', 'C', 'D'].map((id) => new Router(id));
    let msg = routers[0].stampOrigin({ id: '1', content: 'hello' });
    msg = routers[0].prepareForward(msg); // A forwards → ttl 4, hops [A]
    msg = routers[1].prepareForward(msg); // B forwards → ttl 3, hops [A, B]
    msg = routers[2].prepareForward(msg); // C forwards → ttl 2, hops [A, B, C]
    // D should still forward (ttl=2, D not in hops)
    expect(routers[3].shouldForward(msg)).toBe(true);
  });
});
