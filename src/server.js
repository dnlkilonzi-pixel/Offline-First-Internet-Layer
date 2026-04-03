'use strict';

/**
 * server.js – Express HTTP API + Socket.io real-time layer.
 *
 * REST endpoints
 * ──────────────
 * GET  /api/status            – Node info, connectivity, peer list
 * GET  /api/messages          – All stored messages
 * POST /api/messages          – Send a new message (broadcast to peers)
 * POST /api/messages/receive  – Internal: accept a message from a peer
 * GET  /api/peers             – Current peer list
 * POST /api/sync              – Manually trigger a remote sync
 *
 * Socket.io events (server → client)
 * ───────────────────────────────────
 * 'message:new'   – a message was created or received
 * 'peer:new'      – a new peer was discovered
 * 'peer:lost'     – a peer left
 * 'status:change' – connectivity status changed
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server: SocketIoServer } = require('socket.io');

function createServer({ store, discovery, messenger, syncEngine }) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Routes ─────────────────────────────────────────────────────────────────

  app.get('/api/status', (req, res) => {
    res.json({
      online: syncEngine ? syncEngine.isOnline : null,
      peers: discovery ? discovery.peers : [],
      nodeId: discovery ? discovery.nodeId : null,
    });
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

      // Broadcast to local peers (fire-and-forget).
      if (messenger) {
        messenger.broadcast(message).catch(() => { /* non-fatal */ });
      }

      // Notify browser clients.
      io.emit('message:new', message);

      return res.status(201).json(message);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Called by remote peers to deliver messages to this node. */
  app.post('/api/messages/receive', async (req, res) => {
    try {
      const { id, content, sender, type, timestamp, synced } = req.body || {};
      if (!content || !sender) {
        return res.status(400).json({ error: 'content and sender are required.' });
      }
      const message = await store.save({ id, content, sender, type, timestamp, synced });
      io.emit('message:new', message);
      return res.status(200).json({ ok: true, message });
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

  // ── Wire external events to Socket.io ─────────────────────────────────────

  if (discovery) {
    discovery.on('peer:new', (peer) => io.emit('peer:new', peer));
    discovery.on('peer:lost', (peer) => io.emit('peer:lost', peer));
  }

  if (syncEngine) {
    syncEngine.on('online', () => io.emit('status:change', { online: true }));
    syncEngine.on('offline', () => io.emit('status:change', { online: false }));
    syncEngine.on('sync:done', (results) => io.emit('sync:done', results));
  }

  return { app, httpServer, io };
}

module.exports = { createServer };
