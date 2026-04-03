'use strict';

/**
 * server.js – Express HTTP API + Socket.io real-time layer.
 *
 * REST endpoints
 * ──────────────
 * GET  /api/status            – Node info, connectivity tier, peer list
 * GET  /api/identity          – This node's public key
 * GET  /api/messages          – All stored messages (Lamport-ordered)
 * POST /api/messages          – Send a new message (signed + gossiped to peers)
 * POST /api/messages/receive  – Internal: accept a message from a peer (verified + forwarded)
 * GET  /api/peers             – Current peer list
 * POST /api/sync              – Manually trigger a remote sync
 * POST /api/events            – Publish a typed event via EventBus
 * GET  /api/events/:type      – Event history for a type (Lamport-ordered)
 * GET  /api/events/:type/causal – Causal lineage graph for a type
 * GET  /api/docs/:type/:docId – Latest document state
 * GET  /api/digest            – Anti-entropy: this node's message ID digest
 * POST /api/reconcile         – Anti-entropy: return messages peer is missing
 * POST /api/push              – Anti-entropy: accept messages from a peer
 * GET  /api/consistency       – Formal consistency model declaration
 * POST /api/snapshot          – Flush atomic snapshot and truncate WAL
 * GET  /api/query             – Secondary-index query engine
 * GET  /api/benchmark         – Live throughput / convergence benchmark
 *
 * Socket.io events (server → client)
 * ───────────────────────────────────
 * 'message:new'   – a message was created or received
 * 'peer:new'      – a new peer was discovered
 * 'peer:lost'     – a peer left
 * 'status:change' – connectivity status/tier changed
 * 'event:new'     – an EventBus event was published or ingested
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server: SocketIoServer } = require('socket.io');
const rateLimit = require('express-rate-limit');
const Identity = require('./identity');
const ConsistencyMonitor = require('./consistency');
const QueryEngine = require('./query');
const BenchmarkRunner = require('./benchmark');

// Rate limiter for the peer-receive endpoint: max 60 requests per minute per IP.
// This prevents flooding the node with forged or spam messages.
const receiveRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

function createServer({ store, discovery, messenger, syncEngine, identity, router, eventBus, connectivity, antientropy }) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });

  // Initialise the query engine over the store.
  const queryEngine = new QueryEngine(store);

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Routes ─────────────────────────────────────────────────────────────────

  app.get('/api/status', (req, res) => {
    const tier = connectivity ? connectivity.tier : null;
    res.json({
      online: syncEngine ? syncEngine.isOnline : (connectivity ? connectivity.isOnline : null),
      tier,
      peers: discovery ? discovery.peers : [],
      nodeId: discovery ? discovery.nodeId : null,
    });
  });

  app.get('/api/identity', (req, res) => {
    if (!identity) {
      return res.status(503).json({ error: 'Identity not configured.' });
    }
    return res.json({ publicKey: identity.publicKeyHex });
  });

  app.get('/api/messages', async (req, res) => {
    try {
      const messages = await store.getAll();
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/messages', async (req, res) => {
    try {
      const { content, sender, type } = req.body || {};
      if (!content || !sender) {
        return res.status(400).json({ error: 'content and sender are required.' });
      }
      const message = await store.save({ content, sender, type });

      // Attach routing fields for gossip propagation.
      let outMsg = router ? router.stampOrigin(message) : message;

      // Sign the message if an identity is configured.
      if (identity) {
        outMsg = {
          ...outMsg,
          pubkey: identity.publicKeyHex,
          sig: identity.sign({
            id: outMsg.id,
            content: outMsg.content,
            sender: outMsg.sender,
            type: outMsg.type,
            timestamp: outMsg.timestamp,
            lamport: outMsg.lamport,
          }),
        };
      }

      // Broadcast to local peers (fire-and-forget).
      if (messenger) {
        messenger.broadcast(outMsg).catch(() => { /* non-fatal */ });
      }

      // Notify browser clients.
      io.emit('message:new', message);

      return res.status(201).json(message);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Called by remote peers to deliver messages to this node. */
  app.post('/api/messages/receive', receiveRateLimiter, async (req, res) => {
    try {
      const { id, content, sender, type, timestamp, synced, lamport,
              pubkey, sig, ttl, hops } = req.body || {};
      if (!content || !sender) {
        return res.status(400).json({ error: 'content and sender are required.' });
      }

      // Reject messages this node has already forwarded (loop detection).
      if (router && !router.shouldAccept({ hops })) {
        return res.status(200).json({ ok: true, skipped: true });
      }

      // Verify signature when both pubkey and sig are present.
      let verified = false;
      if (pubkey && sig) {
        verified = Identity.verify({ id, content, sender, type, timestamp, lamport }, sig, pubkey);
      }

      const message = await store.save({ id, content, sender, type, timestamp, synced, lamport });
      const fullMessage = { ...message, pubkey, sig, verified, ttl, hops };

      // Gossip-forward to eligible peers if TTL allows.
      if (messenger && router && router.shouldForward(fullMessage)) {
        messenger.broadcast(fullMessage).catch(() => { /* non-fatal */ });
      }

      io.emit('message:new', message);
      return res.status(200).json({ ok: true, message, verified });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/peers', (req, res) => {
    res.json(discovery ? discovery.peers : []);
  });

  app.post('/api/sync', async (req, res) => {
    if (!syncEngine) {
      return res.status(503).json({ error: 'Sync engine not configured.' });
    }
    try {
      const results = await syncEngine.syncNow();
      return res.json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── EventBus routes ────────────────────────────────────────────────────────

  app.post('/api/events', async (req, res) => {
    if (!eventBus) {
      return res.status(503).json({ error: 'EventBus not configured.' });
    }
    try {
      const { type, payload, docId } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: 'type is required.' });
      }
      const event = await eventBus.publish(type, payload || {}, { docId });
      io.emit('event:new', event);
      return res.status(201).json(event);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/events/:type', async (req, res) => {
    if (!eventBus) {
      return res.status(503).json({ error: 'EventBus not configured.' });
    }
    try {
      const events = await eventBus.history(req.params.type);
      return res.json(events);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/docs/:type/:docId', (req, res) => {
    if (!eventBus) {
      return res.status(503).json({ error: 'EventBus not configured.' });
    }
    const doc = eventBus.doc(req.params.type, req.params.docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    return res.json(doc);
  });

  app.get('/api/events/:type/causal', async (req, res) => {
    if (!eventBus) {
      return res.status(503).json({ error: 'EventBus not configured.' });
    }
    try {
      const graph = await eventBus.causalGraph(req.params.type);
      return res.json(graph);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Anti-entropy endpoints ─────────────────────────────────────────────────

  app.get('/api/digest', async (req, res) => {
    if (!antientropy) {
      return res.status(503).json({ error: 'Anti-entropy not configured.' });
    }
    try {
      const ids = await antientropy.digest();
      return res.json({ ids });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reconcile', async (req, res) => {
    if (!antientropy) {
      return res.status(503).json({ error: 'Anti-entropy not configured.' });
    }
    try {
      const { ids: peerIds } = req.body || {};
      const [missing, peerIds_] = await Promise.all([
        antientropy.missing(peerIds || []),
        antientropy.digest(),
      ]);
      return res.json({ missing, peerIds: peerIds_ });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/push', async (req, res) => {
    if (!antientropy) {
      return res.status(503).json({ error: 'Anti-entropy not configured.' });
    }
    try {
      const { messages } = req.body || {};
      const result = await antientropy.reconcile(messages || []);
      // Rebuild EventBus doc index after ingesting reconciled messages.
      if (eventBus && result.accepted > 0) {
        eventBus.reindex().catch(() => { /* non-fatal */ });
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Consistency model endpoint ─────────────────────────────────────────────

  app.get('/api/consistency', (req, res) => {
    return res.json({ guarantees: ConsistencyMonitor.GUARANTEES });
  });

  // ── Storage snapshot endpoint ──────────────────────────────────────────────

  app.post('/api/snapshot', (req, res) => {
    try {
      if (typeof store.snapshot === 'function') {
        store.snapshot();
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Query engine endpoint ──────────────────────────────────────────────────

  app.get('/api/query', (req, res) => {
    try {
      // Accept query as a URL-encoded JSON string: ?q={"filter":[...],"limit":20}
      // Also accept individual shorthand parameters for simple equality look-ups:
      //   ?type=chat&sender=Alice&limit=20&offset=0&order=asc
      let q = {};
      if (req.query.q) {
        try { q = JSON.parse(req.query.q); } catch (_) {
          return res.status(400).json({ error: 'Invalid JSON in "q" parameter.' });
        }
      } else {
        // Build filter from shorthand query params.
        const predicates = [];
        if (req.query.type)   predicates.push({ field: 'type',   op: 'eq', value: req.query.type });
        if (req.query.sender) predicates.push({ field: 'sender', op: 'eq', value: req.query.sender });
        if (req.query.synced !== undefined) {
          predicates.push({ field: 'synced', op: 'eq', value: req.query.synced === 'true' });
        }
        if (predicates.length) q.filter = predicates;
        if (req.query.orderBy) q.orderBy = req.query.orderBy;
        if (req.query.order)   q.order   = req.query.order;
        if (req.query.limit)   q.limit   = parseInt(req.query.limit, 10);
        if (req.query.offset)  q.offset  = parseInt(req.query.offset, 10);
      }

      // Rebuild secondary indexes in case messages were added externally.
      queryEngine.rebuild();
      const results = queryEngine.query(q);
      const plan = queryEngine.explain(q);
      return res.json({ results, count: results.length, plan });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Benchmark endpoint ────────────────────────────────────────────────────

  app.get('/api/benchmark', async (req, res) => {
    try {
      // Use a separate in-memory-only store pair so the benchmark does not
      // corrupt production data.  We create temp stores backed by /tmp files.
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const Store = require('./store');
      const BenchmarkRunner_ = require('./benchmark');
      const ts = Date.now();
      const fpA = path.join(os.tmpdir(), `ofil-bm-srv-A-${ts}.json`);
      const fpB = path.join(os.tmpdir(), `ofil-bm-srv-B-${ts}.json`);
      const sA = new Store(fpA);
      const sB = new Store(fpB);
      const runner = new BenchmarkRunner_();
      const writeN  = req.query.writeN  ? parseInt(req.query.writeN,  10) : 100;
      const readN   = req.query.readN   ? parseInt(req.query.readN,   10) : 50;
      const aeN     = req.query.aeN     ? parseInt(req.query.aeN,     10) : 30;
      const report = await runner.run(sA, sB, { writeN, readN, aeN });
      // Cleanup temp files.
      [fpA, fpB, fpA + '.wal', fpB + '.wal', fpA + '.tmp', fpB + '.tmp']
        .forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } });
      return res.json(report);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Wire external events to Socket.io ─────────────────────────────────────

  if (discovery) {
    discovery.on('peer:new', (peer) => io.emit('peer:new', peer));
    discovery.on('peer:lost', (peer) => io.emit('peer:lost', peer));
  }

  if (syncEngine) {
    syncEngine.on('online', () => io.emit('status:change', { online: true }));
    syncEngine.on('offline', () => io.emit('status:change', { online: false }));
    syncEngine.on('sync:done', (results) => io.emit('sync:done', results));
    syncEngine.on('tier:change', (tier) => io.emit('status:change', { tier }));
  }

  if (eventBus) {
    eventBus.on('event', (event) => io.emit('event:new', event));
  }

  return { app, httpServer, io };
}

module.exports = { createServer };
