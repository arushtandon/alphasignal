'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class BridgeSqliteStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        checksum TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.readStmt = this.db.prepare('SELECT payload FROM bridge_state WHERE id = 1');
    this.writeStmt = this.db.prepare(`
      INSERT INTO bridge_state (id, payload, checksum, updated_at)
      VALUES (1, @payload, @checksum, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, checksum=excluded.checksum, updated_at=excluded.updated_at
    `);
    this.eventStmt = this.db.prepare(`
      INSERT OR IGNORE INTO bridge_events (idempotency_key, event_type, payload, created_at)
      VALUES (@key, @type, @payload, @createdAt)
    `);
  }

  loadState() {
    const row = this.readStmt.get();
    return row ? JSON.parse(row.payload) : null;
  }

  saveState(state, checksum = null) {
    const payload = JSON.stringify(state);
    this.db.transaction(() => {
      this.writeStmt.run({ payload, checksum, updatedAt: new Date().toISOString() });
    })();
  }

  appendEvent(key, type, payload) {
    return this.eventStmt.run({
      key: String(key),
      type: String(type),
      payload: JSON.stringify(payload || {}),
      createdAt: new Date().toISOString()
    }).changes > 0;
  }

  close() {
    this.db.close();
  }
}

module.exports = { BridgeSqliteStore };
