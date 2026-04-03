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
 * GET  /api/docs/:type/:docId – Latest document state
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

// Rate limiter for the peer-receive endpoint: max 60 requests per minute per IP.
// This prevents flooding the node with forged or spam messages.
const receiveRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

function createServer({ store, discovery, messenger, syncEngine, identity, router, eventBus, connectivity }) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });

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
