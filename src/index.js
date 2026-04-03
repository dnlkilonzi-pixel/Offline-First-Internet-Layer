'use strict';

/**
 * index.js – Main entry point.
 *
 * Wires together Store, Discovery, Messenger, SyncEngine and the HTTP server.
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
const { Messenger } = require('./messenger');
const SyncEngine = require('./sync');
const { createServer } = require('./server');

const PORT = parseInt(process.env.PORT || '3000', 10);
const REMOTE_URL = process.env.REMOTE_URL || null;
const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT || '41234', 10);
const NODE_ID = process.env.NODE_ID || undefined;

// Instantiate core components.
const store = new Store();
const discovery = new Discovery({ nodeId: NODE_ID, port: DISCOVERY_PORT });
const messenger = new Messenger(discovery, store);
const syncEngine = new SyncEngine(store, { remoteUrl: REMOTE_URL });

// Build HTTP server.
const { httpServer } = createServer({ store, discovery, messenger, syncEngine });

// Start listening.
httpServer.listen(PORT, () => {
  console.log(`[OFIL] Node "${discovery.nodeId}" listening on http://0.0.0.0:${PORT}`);
  console.log(`[OFIL] Remote sync URL: ${REMOTE_URL || '(not configured)'}`);

  discovery.start(PORT);
  syncEngine.start();

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
  syncEngine.stop();
  httpServer.close(() => process.exit(0));
}
