'use strict';

const { Pool } = require('pg');

class PostgresStore {
  constructor(connectionString, opts = {}) {
    this.enabled = Boolean(connectionString);
    this.pool = this.enabled ? new Pool({
      connectionString,
      ssl: opts.ssl === false ? false : { rejectUnauthorized: false },
      max: Number(opts.max) || 5
    }) : null;
    this.ready = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) return false;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS state_snapshots (
        state_key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS durable_events (
        id BIGSERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        stream TEXT NOT NULL,
        event_type TEXT NOT NULL,
        decision_id TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS durable_events_stream_id ON durable_events(stream, id);
      CREATE INDEX IF NOT EXISTS durable_events_decision_id ON durable_events(decision_id);
      CREATE TABLE IF NOT EXISTS execution_records (
        exec_id TEXT PRIMARY KEY,
        decision_id TEXT,
        order_id TEXT,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS decision_snapshots (
        decision_id TEXT PRIMARY KEY,
        rules_version TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    this.ready = true;
    return true;
  }

  enqueue(task) {
    if (!this.enabled) return Promise.resolve(false);
    this.queue = this.queue.then(() => task()).catch(error => {
      console.warn('Postgres durable-store write failed:', error.message);
      return false;
    });
    return this.queue;
  }

  saveSnapshot(key, payload, schemaVersion = 1) {
    return this.enqueue(async () => {
      await this.pool.query(`
        INSERT INTO state_snapshots (state_key, schema_version, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT(state_key) DO UPDATE
        SET schema_version=excluded.schema_version, payload=excluded.payload, updated_at=NOW()
      `, [key, schemaVersion, JSON.stringify(payload)]);
      return true;
    });
  }

  appendEvent({ idempotencyKey, stream, type, decisionId, payload }) {
    return this.enqueue(async () => {
      const result = await this.pool.query(`
        INSERT INTO durable_events (idempotency_key, stream, event_type, decision_id, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT(idempotency_key) DO NOTHING
      `, [idempotencyKey, stream, type, decisionId || null, JSON.stringify(payload || {})]);
      return result.rowCount > 0;
    });
  }

  saveExecution(execId, decisionId, orderId, payload) {
    if (!execId) return Promise.resolve(false);
    return this.enqueue(async () => {
      await this.pool.query(`
        INSERT INTO execution_records (exec_id, decision_id, order_id, payload, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        ON CONFLICT(exec_id) DO UPDATE
        SET decision_id=COALESCE(excluded.decision_id, execution_records.decision_id),
            order_id=COALESCE(excluded.order_id, execution_records.order_id),
            payload=excluded.payload, updated_at=NOW()
      `, [String(execId), decisionId || null, orderId == null ? null : String(orderId), JSON.stringify(payload || {})]);
      return true;
    });
  }

  saveDecision(snapshot) {
    if (!snapshot || !snapshot.decisionId) return Promise.resolve(false);
    return this.enqueue(async () => {
      await this.pool.query(`
        INSERT INTO decision_snapshots (decision_id, rules_version, payload)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT(decision_id) DO NOTHING
      `, [snapshot.decisionId, snapshot.rulesVersion || 'unknown', JSON.stringify(snapshot)]);
      return true;
    });
  }

  async loadSnapshot(key) {
    if (!this.enabled || !this.ready) return null;
    const result = await this.pool.query('SELECT payload FROM state_snapshots WHERE state_key=$1', [key]);
    return result.rows[0] ? result.rows[0].payload : null;
  }

  async loadExecutions() {
    if (!this.enabled || !this.ready) return [];
    const result = await this.pool.query('SELECT payload FROM execution_records ORDER BY updated_at, exec_id');
    return result.rows.map(row => row.payload).filter(Boolean);
  }

  async loadEvents(stream, limit = 10000) {
    if (!this.enabled || !this.ready) return [];
    const result = await this.pool.query(`
      SELECT payload FROM durable_events
      WHERE stream=$1 ORDER BY id ASC LIMIT $2
    `, [stream, Math.max(1, Math.min(100000, Number(limit) || 10000))]);
    return result.rows.map(row => row.payload).filter(Boolean);
  }

  async health() {
    if (!this.enabled) return { enabled: false, ready: false };
    try {
      const result = await this.pool.query('SELECT NOW() AS now');
      return { enabled: true, ready: this.ready, now: result.rows[0].now };
    } catch (error) {
      return { enabled: true, ready: false, error: error.message };
    }
  }
}

module.exports = { PostgresStore };
