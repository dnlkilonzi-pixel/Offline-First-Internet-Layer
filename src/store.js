'use strict';

/**
 * store.js – File-backed message store.
 *
 * Every message has the shape:
 *   { id, content, sender, type, timestamp, lamport, synced }
 *
 * The `lamport` field is a Lamport logical timestamp that enables
 * deterministic, consistent ordering of messages across distributed nodes
 * without relying on synchronised wall-clock time.
 *
 * Messages are persisted to a JSON file so they survive process restarts.
 * All writes are synchronous-on-the-critical-path but the public API is
 * Promise-based so callers can be switched to async I/O without changing
 * their code.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const LamportClock = require('./clock');

class Store {
  /**
   * @param {string} [filePath] – Absolute path to the backing JSON file.
   *   Defaults to `data/messages.json` relative to the project root.
   */
  constructor(filePath) {
    this._filePath = filePath || path.join(__dirname, '..', 'data', 'messages.json');
    this._messages = [];
    this._clock = new LamportClock();
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
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf8');
        this._messages = JSON.parse(raw);
        // Seed the Lamport clock from the maximum lamport value in stored messages
        // so that new events are always ordered after persisted ones.
        const maxLamport = this._messages.reduce(
          (max, m) => (m.lamport !== undefined ? Math.max(max, m.lamport) : max),
          0
        );
        if (maxLamport > 0) {
          this._clock.update(maxLamport);
        }
      }
    } catch (_) {
      this._messages = [];
    }
  }

  _persist() {
    this._ensureDir();
    fs.writeFileSync(this._filePath, JSON.stringify(this._messages, null, 2), 'utf8');
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
    // Avoid duplicate IDs when messages arrive from peers
    if (!this._messages.find((m) => m.id === message.id)) {
      this._messages.push(message);
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
   * Remove all messages (useful for tests).
   * @returns {Promise<void>}
   */
  async clear() {
    this._messages = [];
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
}

module.exports = Store;
