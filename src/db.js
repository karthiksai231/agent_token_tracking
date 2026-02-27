'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

let _db = null;

function getDb(dataDir) {
  if (_db) return _db;

  const dir = dataDir || path.join(os.homedir(), '.llm-spend');
  fs.mkdirSync(dir, { recursive: true });

  _db = new Database(path.join(dir, 'llm-spend.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      provider              TEXT NOT NULL,
      model                 TEXT NOT NULL,
      session_id            TEXT,
      project_path          TEXT,
      request_id            TEXT,
      occurred_at           TEXT NOT NULL,
      imported_at           TEXT NOT NULL DEFAULT (datetime('now')),
      input_tokens          INTEGER DEFAULT 0,
      output_tokens         INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens     INTEGER DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0.0,
      source                TEXT NOT NULL DEFAULT 'claude-code',
      UNIQUE(provider, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON usage_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_events_model        ON usage_events(model);
    CREATE INDEX IF NOT EXISTS idx_events_session_id   ON usage_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_project      ON usage_events(project_path);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('retention_days', 'null'),
      ('auto_import_on_start', 'true'),
      ('claude_data_dir', 'null');

    CREATE TABLE IF NOT EXISTS import_state (
      file_path       TEXT PRIMARY KEY,
      file_mtime      INTEGER NOT NULL,
      last_line_index INTEGER NOT NULL DEFAULT 0,
      last_imported   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Settings ─────────────────────────────────────────────────────────────────

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings(key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

function getAllSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const r of rows) result[r.key] = JSON.parse(r.value);
  return result;
}

// ── Import State ──────────────────────────────────────────────────────────────

function getImportState(db, filePath) {
  return db.prepare('SELECT * FROM import_state WHERE file_path = ?').get(filePath);
}

function upsertImportState(db, filePath, fileMtime, lastLineIndex) {
  db.prepare(`
    INSERT INTO import_state(file_path, file_mtime, last_line_index, last_imported)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      last_line_index = excluded.last_line_index,
      last_imported = excluded.last_imported
  `).run(filePath, fileMtime, lastLineIndex);
}

function clearImportState(db) {
  db.prepare('DELETE FROM import_state').run();
}

// ── Events ────────────────────────────────────────────────────────────────────

function insertEvent(db, ev) {
  return db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (provider, model, session_id, project_path, request_id, occurred_at,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
       cost_usd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ev.provider, ev.model, ev.session_id || null, ev.project_path || null,
    ev.request_id || null, ev.occurred_at,
    ev.input_tokens || 0, ev.output_tokens || 0,
    ev.cache_creation_tokens || 0, ev.cache_read_tokens || 0,
    ev.cost_usd || 0, ev.source || 'claude-code'
  );
}

function getOverview(db, from, to) {
  let where = buildWhere(from, to);
  const totals = db.prepare(`
    SELECT
      COUNT(*)          AS total_requests,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cost_usd)     AS cost_usd
    FROM usage_events ${where.sql}
  `).get(...where.params);

  // Exclude null/synthetic model entries (zero-cost placeholders)
  const modelWhere = where.params.length
    ? where.sql + " AND model IS NOT NULL AND model != '<synthetic>'"
    : "WHERE model IS NOT NULL AND model != '<synthetic>'"
  const byModel = db.prepare(`
    SELECT model, provider,
      COUNT(*) AS requests,
      SUM(input_tokens)          AS input_tokens,
      SUM(output_tokens)         AS output_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cache_read_tokens)     AS cache_read_tokens,
      SUM(cost_usd) AS cost_usd
    FROM usage_events ${modelWhere}
    GROUP BY model, provider
    ORDER BY cost_usd DESC
  `).all(...where.params);

  return { totals, byModel };
}

function getTimeseries(db, from, to, groupBy = 'day') {
  let where = buildWhere(from, to);
  const tsWhere = where.params.length
    ? where.sql + " AND model IS NOT NULL AND model != '<synthetic>'"
    : "WHERE model IS NOT NULL AND model != '<synthetic>'"
  const rows = db.prepare(`
    SELECT
      substr(occurred_at, 1, 10) AS date,
      model,
      provider,
      SUM(cost_usd) AS cost_usd,
      COUNT(*) AS requests
    FROM usage_events ${tsWhere}
    GROUP BY date, model, provider
    ORDER BY date ASC
  `).all(...where.params);
  return rows;
}

function getTopSessions(db, from, to, limit = 20) {
  let where = buildWhere(from, to);
  return db.prepare(`
    SELECT
      session_id,
      project_path,
      COUNT(*) AS requests,
      SUM(input_tokens)          AS input_tokens,
      SUM(output_tokens)         AS output_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cache_read_tokens)     AS cache_read_tokens,
      SUM(cost_usd) AS cost_usd,
      MIN(occurred_at) AS started_at,
      MAX(occurred_at) AS ended_at,
      GROUP_CONCAT(DISTINCT model) AS models
    FROM usage_events ${where.sql}
    GROUP BY session_id
    ORDER BY cost_usd DESC
    LIMIT ?
  `).all(...where.params, limit);
}

function getEvents(db, { page = 1, limit = 50, model, provider, from, to, session_id } = {}) {
  const conditions = [];
  const params = [];

  if (from)       { conditions.push("occurred_at >= ?"); params.push(from); }
  if (to)         { conditions.push("occurred_at <= ?"); params.push(to + 'T23:59:59'); }
  if (model)      { conditions.push("model = ?");        params.push(model); }
  if (provider)   { conditions.push("provider = ?");     params.push(provider); }
  if (session_id) { conditions.push("session_id = ?");   params.push(session_id); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM usage_events ${where}`).get(...params).n;
  const rows  = db.prepare(`
    SELECT * FROM usage_events ${where}
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}

function getModels(db) {
  return db.prepare('SELECT DISTINCT model FROM usage_events ORDER BY model').all().map(r => r.model);
}

function deleteEvents(db, from, to) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push("occurred_at >= ?"); params.push(from); }
  if (to)   { conditions.push("occurred_at <= ?"); params.push(to + 'T23:59:59'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`DELETE FROM usage_events ${where}`).run(...params);
}

function deleteAll(db) {
  db.prepare('DELETE FROM usage_events').run();
  db.prepare('DELETE FROM import_state').run();
}

function applyRetention(db) {
  const days = getSetting(db, 'retention_days');
  if (!days) return;
  db.prepare(`
    DELETE FROM usage_events
    WHERE occurred_at < datetime('now', ? || ' days')
  `).run(-days);
}

function exportData(db, from, to) {
  let where = buildWhere(from, to);
  return db.prepare(`SELECT * FROM usage_events ${where.sql} ORDER BY occurred_at DESC`).all(...where.params);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWhere(from, to) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push("occurred_at >= ?"); params.push(from); }
  if (to)   { conditions.push("occurred_at <= ?"); params.push(to + 'T23:59:59'); }
  return {
    sql: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
}

module.exports = {
  getDb,
  getSetting, setSetting, getAllSettings,
  getImportState, upsertImportState, clearImportState,
  insertEvent,
  getOverview, getTimeseries, getTopSessions, getEvents, getModels,
  deleteEvents, deleteAll, applyRetention,
  exportData
};
