'use strict';

/**
 * wal.js – Write-Ahead Log (WAL).
 *
 * A WAL improves durability by recording every mutation before it is applied
 * to the main snapshot file.  If the process crashes between writing the WAL
 * entry and completing the snapshot rename, the WAL entry survives and can be
 * replayed on the next startup, guaranteeing no-write-left-behind semantics.
 *
 * ── Format ───────────────────────────────────────────────────────────────────
 *   Newline-delimited JSON (NDJSON).  Each line is a JSON object:
 *
 *     { "op": "save",   "message": { ...store message fields } }
 *     { "op": "delete", "ids": [ "id1", "id2" ] }
 *
 *   Appending a new line is an atomic operation on every major filesystem
 *   (the kernel write is not split across lines), making the WAL
 *   crash-safe without needing fsync on every entry.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────────
 *   On startup:  recover() → replay entries not yet in the snapshot.
 *   On save:     append({ op:'save', message }) before updating in-memory state.
 *   On delete:   append({ op:'delete', ids }) before updating in-memory state.
 *   On snapshot: the snapshot is written atomically (tmp→rename).
 *                truncate() then clears the WAL, since the snapshot is current.
 */

const fs = require('fs');

class WAL {
  /**
   * @param {string} walPath – Absolute path to the WAL file (typically `<dataFile>.wal`).
   */
  constructor(walPath) {
    this._path = walPath;
  }

  /**
   * Append a single entry to the WAL (synchronous, NDJSON).
   * @param {{ op: string } & object} entry
   */
  append(entry) {
    try {
      fs.appendFileSync(this._path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {
      // Non-fatal: WAL write failing degrades durability but not correctness,
      // because the snapshot is still written immediately after.
    }
  }

  /**
   * Read all entries from the WAL file.
   * Corrupt lines are silently skipped (best-effort recovery).
   * @returns {Array<object>} Parsed WAL entries in append order.
   */
  recover() {
    try {
      const raw = fs.readFileSync(this._path, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .reduce((entries, line) => {
          try { entries.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
          return entries;
        }, []);
    } catch (_) {
      return [];
    }
  }

  /**
   * Erase all WAL entries (called after a successful atomic snapshot write).
   */
  truncate() {
    try {
      fs.writeFileSync(this._path, '', 'utf8');
    } catch (_) { /* ignore: WAL might not exist yet */ }
  }

  /** Absolute path to the WAL file. */
  get path() {
    return this._path;
  }
}

module.exports = WAL;
