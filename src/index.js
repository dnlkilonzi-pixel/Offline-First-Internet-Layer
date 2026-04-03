'use strict';

/**
 * index.js – Main entry point.
 *
 * Wires together Store, Discovery, Messenger, Router, Identity,
 * ConnectivityMonitor, SyncEngine, EventBus and the HTTP server.
 *
 * Configuration is read from environment variables:
 *
 *   PORT           – HTTP server port (default 3000)
 *   REMOTE_URL     – Full URL of the remote sync endpoint (optional)
 *   DISCOVERY_PORT – UDP port for peer discovery (default 41234)
 *   NODE_ID        – Human-readable name for this node (optional)
 */

const Store = require('./store');
const Discovery = require('./discovery');
const { Messenger, postJson } = require('./messenger');
const Router = require('./router');
const Identity = require('./identity');
const ConnectivityMonitor = require('./connectivity');
const SyncEngine = require('./sync');
const EventBus = require('./eventbus');
const AntiEntropy = require('./antientropy');
const Compaction = require('./compaction');
const { createServer } = require('./server');

const PORT = parseInt(process.env.PORT || '3000', 10);
const REMOTE_URL = process.env.REMOTE_URL || null;
const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT || '41234', 10);
const NODE_ID = process.env.NODE_ID || undefined;

// Instantiate core components.
const store = new Store();
const identity = new Identity();
const discovery = new Discovery({ nodeId: NODE_ID, port: DISCOVERY_PORT });
const router = new Router(discovery.nodeId);
const messenger = new Messenger(discovery, store, router);
const connectivity = new ConnectivityMonitor(discovery);
const syncEngine = new SyncEngine(store, { remoteUrl: REMOTE_URL, connectivity });
const eventBus = new EventBus(store, store.clock, discovery.nodeId);
const antientropy = new AntiEntropy(store, discovery.nodeId);
const compaction = new Compaction(store);

// Build HTTP server.
const { httpServer } = createServer({
  store,
  discovery,
  messenger,
  syncEngine,
  identity,
  router,
  eventBus,
  connectivity,
  antientropy,
});

// Start listening.
httpServer.listen(PORT, () => {
  console.log(`[OFIL] Node "${discovery.nodeId}" listening on http://0.0.0.0:${PORT}`);
  console.log(`[OFIL] Identity public key: ${identity.publicKeyHex}`);
  console.log(`[OFIL] Remote sync URL: ${REMOTE_URL || '(not configured)'}`);

  discovery.start(PORT);
  connectivity.start();
  syncEngine.start();
  // Schedule log compaction every 5 minutes; keep max 10 000 messages.
  compaction.schedule(5 * 60_000, { maxCount: 10_000 });

  console.log('[OFIL] Peer discovery started. Waiting for peers…');
});

discovery.on('peer:new', (p) =>
  console.log(`[OFIL] Peer discovered: ${p.nodeId} @ ${p.ip}:${p.apiPort}`)
);
discovery.on('peer:lost', (p) =>
  console.log(`[OFIL] Peer lost: ${p.nodeId}`)
);
discovery.on('error', (err) =>
  console.warn(`[OFIL] Discovery error (non-fatal): ${err.message}`)
);
connectivity.on('tier:change', (tier, prev) => {
  console.log(`[OFIL] Connectivity tier: ${prev} → ${tier}`);
  // Partition healing: when we reconnect (any tier above NONE), run anti-entropy
  // with all known peers so we catch up on messages we missed while partitioned.
  if (prev === 'none' && tier !== 'none') {
    const peers = discovery.peers;
    if (peers.length > 0) {
      console.log(`[OFIL] Partition healed – running anti-entropy with ${peers.length} peer(s)…`);
      Promise.all(
        peers.map((peer) =>
          antientropy.syncWithPeer(peer, postJson).catch(() => { /* non-fatal */ })
        )
      ).then(() => {
        eventBus.reindex().catch(() => { /* non-fatal */ });
      });
    }
  }
});
syncEngine.on('online', () => console.log('[OFIL] Internet available – syncing…'));
syncEngine.on('offline', () => console.log('[OFIL] Internet unavailable.'));
syncEngine.on('sync:done', (results) => {
  const ok = results.filter((r) => r.ok).length;
  console.log(`[OFIL] Sync complete: ${ok}/${results.length} messages pushed.`);
});

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('[OFIL] Shutting down…');
  discovery.stop();
  connectivity.stop();
  syncEngine.stop();
  compaction.stop();
  httpServer.close(() => process.exit(0));
}
