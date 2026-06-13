import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let _db = null;

export function openRegistry(dataDir) {
  if (_db) return _db;
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'registry.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT,
      role          TEXT NOT NULL DEFAULT 'client'
                    CHECK(role IN ('admin','client')),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS boxes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      token_hash   TEXT UNIQUE NOT NULL,
      last_seen_at DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES users(id),
      box_id       INTEGER REFERENCES boxes(id),
      name         TEXT NOT NULL,
      event_date   DATE,
      status       TEXT NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','ready','loaded','live','closed','pushed','processed','purged')),
      pulled_at    DATETIME,
      pushed_at    DATETIME,
      processed_at DATETIME,
      purged_at    DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT NOT NULL,
      video_id    TEXT,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','running','done','failed')),
      attempts    INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at  DATETIME,
      finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   TEXT,
      box_id     INTEGER,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  _db = db;
  return db;
}

export function getDb() {
  if (!_db) throw new Error('Registry not initialized — call openRegistry() first');
  return _db;
}

export function closeRegistry() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── users ────────────────────────────────────────────────────────────────────

export function insertUser(db, { email, password_hash, name = null, role = 'client' }) {
  return db
    .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(email, password_hash, name, role);
}

export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ── events ───────────────────────────────────────────────────────────────────

export function listEvents(db, { userId, role }) {
  if (role === 'admin') return db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  return db.prepare('SELECT * FROM events WHERE owner_id = ? ORDER BY created_at DESC').all(userId);
}

export function getEvent(db, id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

export function insertEvent(db, { id, owner_id, name, event_date = null }) {
  return db
    .prepare('INSERT INTO events (id, owner_id, name, event_date) VALUES (?, ?, ?, ?)')
    .run(id, owner_id, name, event_date);
}

export function updateEvent(db, id, fields) {
  const allowed = ['name', 'event_date', 'box_id', 'status',
    'pulled_at', 'pushed_at', 'processed_at', 'purged_at'];
  const updates = Object.keys(fields)
    .filter((k) => allowed.includes(k))
    .map((k) => `${k} = ?`);
  if (updates.length === 0) return;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  const values = Object.keys(fields).filter((k) => allowed.includes(k)).map((k) => fields[k]);
  db.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}

export function deleteEvent(db, id) {
  return db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

// ── boxes ────────────────────────────────────────────────────────────────────

export function listBoxes(db) {
  return db.prepare('SELECT * FROM boxes ORDER BY created_at DESC').all();
}

export function insertBox(db, { name, token_hash }) {
  return db.prepare('INSERT INTO boxes (name, token_hash) VALUES (?, ?)').run(name, token_hash);
}

export function getBoxByTokenHash(db, token_hash) {
  return db.prepare('SELECT * FROM boxes WHERE token_hash = ?').get(token_hash);
}

export function updateBoxSeen(db, id) {
  return db.prepare('UPDATE boxes SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function deleteBox(db, id) {
  return db.prepare('DELETE FROM boxes WHERE id = ?').run(id);
}

// ── sync_log ─────────────────────────────────────────────────────────────────

export function insertSyncLog(db, { event_id = null, box_id = null, action, detail = null }) {
  return db
    .prepare('INSERT INTO sync_log (event_id, box_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(event_id, box_id, action, detail ? JSON.stringify(detail) : null);
}
