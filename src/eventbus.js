'use strict';

/**
 * eventbus.js – Typed event bus and document sync engine.
 *
 * Provides a higher-level abstraction over raw messages, turning the system
 * into an offline-first backend alternative (Firebase-like):
 *
 * ── Event model ──────────────────────────────────────────────────────────────
 *   Every published item is a typed event:
 *     { id, type, payload, docId?, version, lamport, timestamp, sender, synced }
 *
 *   Subscribers register for any event type:
 *     bus.on('inventory:update', handler)
 *
 *   Publishers emit events:
 *     await bus.publish('inventory:update', { item: 'pencils', count: 50 })
 *
 * ── Document model ────────────────────────────────────────────────────────────
 *   A document is identified by (type, docId).  The "current" value is the
 *   event with the highest Lamport timestamp for that (type, docId) pair.
 *   This is last-write-wins (LWW) conflict resolution via Lamport clocks.
 *
 *     await bus.publish('products', { name: 'Pencil', price: 10 }, { docId: 'item-1' })
 *     bus.doc('products', 'item-1')  // → latest event payload
 *
 * ── Conflict resolution ───────────────────────────────────────────────────────
 *   When an event arrives from a peer (bus.ingest()):
 *   - If this is a document event and we already have a newer version (higher
 *     Lamport), we reject the incoming event (our version wins).
 *   - Otherwise we accept and update our document index.
 *   Tie-break: lower sender id wins (deterministic).
 *
 * Events emitted by the bus itself:
 *   '<type>'  (event) – An event of that type was published or ingested.
 *   'event'   (event) – Any event.
 *   'conflict' (incoming, retained) – An incoming event was rejected.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const LamportClock = require('./clock');

class EventBus extends EventEmitter {
  /**
   * @param {import('./store')} store     – Backing store for persistence.
   * @param {LamportClock}      [clock]  – Shared Lamport clock (or a fresh one).
   * @param {string}            [nodeId] – This node's identifier.
   */
  constructor(store, clock, nodeId) {
    super();
    this._store = store;
    this._clock = clock || new LamportClock();
    this._nodeId = nodeId || 'local';
    this._docs = new Map(); // `${type}:${docId}` → latest accepted event
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Publish a locally-originated typed event.
   *
   * @param {string}  type      – Event / document type, e.g. "inventory:update".
   * @param {object}  payload   – Arbitrary JSON payload.
   * @param {object}  [opts]
   * @param {string}  [opts.docId]   – Document ID for document-model events.
   * @param {number}  [opts.version] – Explicit version (defaults to Lamport value).
   * @returns {Promise<object>} The persisted event.
   */
  async publish(type, payload, opts = {}) {
    if (!type || typeof type !== 'string') {
      throw new Error('Event type is required.');
    }
    const lamport = this._clock.tick();
    const id = opts.docId ? `${type}:${opts.docId}` : uuidv4();
    const event = {
      id,
      type,
      payload,
      docId: opts.docId || null,
      version: opts.version !== undefined ? opts.version : lamport,
      lamport,
      timestamp: new Date().toISOString(),
      sender: this._nodeId,
      synced: false,
    };

    // Persist via the backing store (event content serialised as JSON string).
    await this._store.save({
      id: event.id,
      content: JSON.stringify(event),
      sender: this._nodeId,
      type,
      timestamp: event.timestamp,
      lamport: event.lamport,
    });

    if (event.docId) {
      this._updateDocIndex(event);
    }

    this.emit(type, event);
    this.emit('event', event);

    return event;
  }

  /**
   * Ingest an event received from a peer and apply conflict resolution.
   *
   * @param {object} event – Raw event object from a peer.
   * @returns {Promise<{ accepted: boolean, event: object }>}
   */
  async ingest(event) {
    this._clock.update(event.lamport || 0);

    if (event.docId) {
      const key = `${event.type}:${event.docId}`;
      const current = this._docs.get(key);
      if (current) {
        // Conflict: compare by Lamport; higher wins. Tie-break: lower sender id.
        const cmp = LamportClock.compare(current, event);
        const currentWins = cmp > 0 || (cmp === 0 && current.sender <= event.sender);
        if (currentWins) {
          this.emit('conflict', event, current);
          return { accepted: false, event: current };
        }
      }
      this._updateDocIndex(event);
    }

    await this._store.save({
      id: event.id,
      content: JSON.stringify(event),
      sender: event.sender,
      type: event.type,
      timestamp: event.timestamp,
      lamport: event.lamport,
    });

    this.emit(event.type, event);
    this.emit('event', event);

    return { accepted: true, event };
  }

  /**
   * Get the latest accepted state of a document.
   *
   * @param {string} type
   * @param {string} docId
   * @returns {object|null}
   */
  doc(type, docId) {
    return this._docs.get(`${type}:${docId}`) || null;
  }

  /**
   * Return all events of a given type, ordered by Lamport clock (oldest first).
   *
   * @param {string} type
   * @returns {Promise<object[]>}
   */
  async history(type) {
    const all = await this._store.getAll();
    return all
      .filter((m) => m.type === type)
      .map((m) => {
        try { return JSON.parse(m.content); } catch (_) { return m; }
      })
      .sort(LamportClock.compare);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _updateDocIndex(event) {
    const key = `${event.type}:${event.docId}`;
    const current = this._docs.get(key);
    if (!current || LamportClock.compare(event, current) > 0) {
      this._docs.set(key, event);
    }
  }
}

module.exports = EventBus;
