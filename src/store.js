'use strict';

/**
 * store.js – File-backed message store.
 *
 * Every message has the shape:
 *   { id, content, sender, type, timestamp, synced }
 *
 * Messages are persisted to a JSON file so they survive process restarts.
 * All writes are synchronous-on-the-critical-path but the public API is
 * Promise-based so callers can be switched to async I/O without changing
 * their code.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class Store {
  /**
   * @param {string} [filePath] – Absolute path to the backing JSON file.
   *   Defaults to `data/messages.json` relative to the project root.
   */
  constructor(filePath) {
    this._filePath = filePath || path.join(__dirname, '..', 'data', 'messages.json');
    this._messages = [];
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
    const message = {
      id: data.id || uuidv4(),
      content: data.content,
      sender: data.sender,
      type: data.type || 'general',
      timestamp: data.timestamp || new Date().toISOString(),
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
   * Return all messages, most-recent first.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return [...this._messages].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
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
}

module.exports = Store;
