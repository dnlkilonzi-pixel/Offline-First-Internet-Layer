'use strict';

/**
 * store.js – File-backed message store with WAL durability and type index.
 *
 * Every message has the shape:
 *   { id, content, sender, type, timestamp, lamport, synced }
 *
 * The `lamport` field is a Lamport logical timestamp that enables
 * deterministic, consistent ordering of messages across distributed nodes
 * without relying on synchronised wall-clock time.
 *
 * ── Durability ────────────────────────────────────────────────────────────────
 *   Every mutation is appended to a Write-Ahead Log (WAL) before the in-memory
 *   state is updated and before the snapshot is written.  On startup the WAL
 *   is replayed on top of the last snapshot, so no write is ever lost — even
 *   if the process crashes between the WAL write and the snapshot write.
 *
 *   The snapshot is written atomically: first to a `.tmp` file, then renamed
 *   into place.  On POSIX filesystems rename(2) is atomic.
 *
 * ── In-memory type index ─────────────────────────────────────────────────────
 *   A Map<type, Set<id>> is maintained alongside _messages for O(1) look-up
 *   by type.  Use getByType(type) instead of filtering getAll().
 *
 * ── snapshot() ───────────────────────────────────────────────────────────────
 *   Writes the atomic snapshot and truncates the WAL.  Call explicitly to
 *   compact the WAL (Compaction does this after each GC pass).
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const LamportClock = require('./clock');
const WAL = require('./wal');

class Store {
  /**
   * @param {string} [filePath] – Absolute path to the backing JSON file.
   *   Defaults to `data/messages.json` relative to the project root.
   */
  constructor(filePath) {
    this._filePath = filePath || path.join(__dirname, '..', 'data', 'messages.json');
    this._walPath = this._filePath + '.wal';
    this._messages = [];
    this._clock = new LamportClock();
    this._index = new Map(); // type → Set<id>
    this._wal = new WAL(this._walPath);
    this._load();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _ensureDir() {
    const dir = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _load() {
    // 1. Load the last snapshot.
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf8');
        this._messages = JSON.parse(raw);
      }
    } catch (_) {
      this._messages = [];
    }

    // 2. Replay WAL entries that are not already in the snapshot.
    const existingIds = new Set(this._messages.map((m) => m.id));
    for (const entry of this._wal.recover()) {
      if (entry.op === 'save' && entry.message && !existingIds.has(entry.message.id)) {
        this._messages.push(entry.message);
        existingIds.add(entry.message.id);
      } else if (entry.op === 'delete' && Array.isArray(entry.ids)) {
        const toRemove = new Set(entry.ids);
        this._messages = this._messages.filter((m) => !toRemove.has(m.id));
        for (const id of toRemove) existingIds.delete(id);
      }
    }

    // 3. Seed the Lamport clock from the highest known value.
    const maxLamport = this._messages.reduce(
      (max, m) => (m.lamport !== undefined ? Math.max(max, m.lamport) : max),
      0
    );
    if (maxLamport > 0) {
      this._clock.update(maxLamport);
    }

    // 4. Build in-memory type index.
    this._buildIndex();
  }

  /** Write a full atomic snapshot (tmp→rename) – does NOT touch the WAL. */
  _persist() {
    this._ensureDir();
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._messages, null, 2), 'utf8');
    fs.renameSync(tmp, this._filePath);
  }

  // ── Index helpers ────────────────────────────────────────────────────────

  _buildIndex() {
    this._index = new Map();
    for (const msg of this._messages) {
      this._indexMessage(msg);
    }
  }

  _indexMessage(msg) {
    const t = msg.type || 'general';
    if (!this._index.has(t)) this._index.set(t, new Set());
    this._index.get(t).add(msg.id);
  }

  _removeFromIndex(id, type) {
    const ids = this._index.get(type || 'general');
    if (ids) ids.delete(id);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Save a new message.
   * @param {{ content: string, sender: string, type?: string }} data
   * @returns {Promise<object>} The saved message.
   */
  async save(data) {
    if (!data || !data.content || !data.sender) {
      throw new Error('Message must have "content" and "sender".');
    }
    // Advance the local Lamport clock: update from remote time if provided,
    // otherwise tick for a local event.
    const lamport =
      data.lamport !== undefined
        ? this._clock.update(data.lamport)
        : this._clock.tick();

    const message = {
      id: data.id || uuidv4(),
      content: data.content,
      sender: data.sender,
      type: data.type || 'general',
      timestamp: data.timestamp || new Date().toISOString(),
      lamport,
      synced: data.synced !== undefined ? data.synced : false,
    };

    // Avoid duplicate IDs when messages arrive from peers.
    if (!this._messages.find((m) => m.id === message.id)) {
      // WAL-first: record the intent before mutating state.
      this._wal.append({ op: 'save', message });
      this._messages.push(message);
      this._indexMessage(message);
      this._persist();
    }
    return message;
  }

  /**
   * Return all messages ordered by Lamport timestamp descending
   * (highest Lamport = most recent causal event = shown first in the UI).
   * Ties broken by message id for a consistent total order.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return [...this._messages].sort((a, b) => LamportClock.compare(b, a));
  }

  /**
   * Return all messages of a given type, ordered by Lamport descending.
   * Uses the in-memory type index for O(1) look-up by type.
   *
   * @param {string} type
   * @returns {object[]}
   */
  getByType(type) {
    const ids = this._index.get(type) || new Set();
    return this._messages
      .filter((m) => ids.has(m.id))
      .sort((a, b) => LamportClock.compare(b, a));
  }

  /**
   * Return messages that have not yet been synced to the remote server.
   * @returns {Promise<object[]>}
   */
  async getUnsynced() {
    return this._messages.filter((m) => !m.synced);
  }

  /**
   * Mark one message as synced.
   * @param {string} id
   * @returns {Promise<boolean>} true if found and updated.
   */
  async markSynced(id) {
    const msg = this._messages.find((m) => m.id === id);
    if (!msg) return false;
    msg.synced = true;
    this._persist();
    return true;
  }

  /**
   * Remove messages by ID.  Used by Compaction to prune superseded entries.
   * @param {string[]} ids
   * @returns {void}
   */
  deleteMessages(ids) {
    const toRemove = new Set(ids);
    // WAL-first: record the delete intent.
    this._wal.append({ op: 'delete', ids });
    for (const id of toRemove) {
      const msg = this._messages.find((m) => m.id === id);
      if (msg) this._removeFromIndex(id, msg.type);
    }
    this._messages = this._messages.filter((m) => !toRemove.has(m.id));
    this._persist();
  }

  /**
   * Write an atomic snapshot and truncate the WAL.
   *
   * Call this after a compaction/GC pass so the WAL does not grow unboundedly.
   * It is also called automatically on every save/delete via _persist().
   * @returns {void}
   */
  snapshot() {
    this._persist();
    this._wal.truncate();
  }

  /**
   * Remove all messages (useful for tests).
   * @returns {Promise<void>}
   */
  async clear() {
    this._messages = [];
    this._index = new Map();
    this._wal.truncate();
    this._persist();
  }

  /** Number of stored messages. */
  get size() {
    return this._messages.length;
  }

  /** The Lamport clock used by this store. */
  get clock() {
    return this._clock;
  }

  /** Absolute path to the WAL file (useful for test cleanup). */
  get walPath() {
    return this._walPath;
  }
}

module.exports = Store;
