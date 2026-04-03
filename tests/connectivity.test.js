'use strict';

const net = require('net');
const ConnectivityMonitor = require('../src/connectivity');

// Helper: start a TCP server on a random port, return { server, port }.
function startTcpEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.end());
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('ConnectivityMonitor', () => {
  test('TIERS constant is accessible as a static property', () => {
    const T = ConnectivityMonitor.TIERS;
    expect(T.NONE).toBe('none');
    expect(T.LAN).toBe('lan');
    expect(T.HOTSPOT).toBe('hotspot');
    expect(T.WAN).toBe('wan');
  });

  test('starts with NONE tier', () => {
    const monitor = new ConnectivityMonitor(null);
    expect(monitor.tier).toBe('none');
    expect(monitor.isOnline).toBe(false);
  });

  test('isOnline is false for LAN tier', () => {
    const monitor = new ConnectivityMonitor({ peers: [{ nodeId: 'x' }] });
    // Manually set tier for assertion.
    monitor._tier = ConnectivityMonitor.TIERS.LAN;
    expect(monitor.isOnline).toBe(false);
  });

  test('isOnline is true for WAN tier', () => {
    const monitor = new ConnectivityMonitor(null);
    monitor._tier = ConnectivityMonitor.TIERS.WAN;
    expect(monitor.isOnline).toBe(true);
  });

  test('isOnline is true for HOTSPOT tier', () => {
    const monitor = new ConnectivityMonitor(null);
    monitor._tier = ConnectivityMonitor.TIERS.HOTSPOT;
    expect(monitor.isOnline).toBe(true);
  });

  test('emits tier:change when tier upgrades', async () => {
    const { server, port } = await startTcpEcho();

    const monitor = new ConnectivityMonitor(
      { peers: [] }, // no LAN peers
      {
        wanHost: '127.0.0.1',
        wanPort: port,
        hotspotHosts: [],
        probeTimeout: 2000,
        checkInterval: 60_000, // disable auto-check
      }
    );

    const changes = [];
    monitor.on('tier:change', (tier, prev) => changes.push({ tier, prev }));

    // Manually trigger a check.
    await monitor._check();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ tier: 'wan', prev: 'none' });
    expect(monitor.tier).toBe('wan');
    expect(monitor.isOnline).toBe(true);

    await new Promise((r) => server.close(r));
  });

  test('does not emit when tier is unchanged', async () => {
    const monitor = new ConnectivityMonitor({ peers: [] }, {
      wanHost: '127.0.0.1',
      wanPort: 1, // nothing listening
      hotspotHosts: [],
      probeTimeout: 200,
      checkInterval: 60_000,
    });

    const changes = [];
    monitor.on('tier:change', (t) => changes.push(t));

    await monitor._check(); // NONE → NONE
    await monitor._check(); // still NONE
    expect(changes).toHaveLength(0);
  });

  test('detects LAN tier when peers are present', async () => {
    const monitor = new ConnectivityMonitor(
      { peers: [{ nodeId: 'peer-1' }] },
      {
        wanHost: '127.0.0.1',
        wanPort: 1, // no WAN
        hotspotHosts: [],
        probeTimeout: 200,
        checkInterval: 60_000,
      }
    );

    await monitor._check();
    expect(monitor.tier).toBe('lan');
  });

  test('stop clears the timer', () => {
    jest.useFakeTimers();
    const monitor = new ConnectivityMonitor(null, { checkInterval: 1000 });
    monitor.start();
    monitor.stop();
    jest.advanceTimersByTime(5000);
    jest.useRealTimers();
  });
});
