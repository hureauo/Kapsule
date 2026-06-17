import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
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
      password_hash TEXT,
      name          TEXT,
      role          TEXT NOT NULL DEFAULT 'client'
                    CHECK(role IN ('admin','client')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registration_tokens (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  DATETIME NOT NULL,
      used_at     DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
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

  // Migration: add 'active' to users if the table predates 6B.1
  const userCols = db.pragma('table_info(users)').map((c) => c.name);
  if (!userCols.includes('active')) {
    db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

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

export function insertUser(db, { email, password_hash = null, name = null, role = 'client', active = 1 }) {
  return db
    .prepare('INSERT INTO users (email, password_hash, name, role, active) VALUES (?, ?, ?, ?, ?)')
    .run(email, password_hash, name, role, active);
}

export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers(db) {
  return db
    .prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at DESC')
    .all();
}

export function updateUser(db, id, fields) {
  const allowed = ['active', 'name', 'password_hash'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

// ── registration_tokens ───────────────────────────────────────────────────────

export function createRegistrationToken(db, { user_id, expires_in_ms = 7 * 24 * 60 * 60 * 1000 }) {
  const token = randomBytes(32).toString('hex');
  const token_hash = createHash('sha256').update(token).digest('hex');
  const expires_at = new Date(Date.now() + expires_in_ms).toISOString();
  db.prepare('INSERT INTO registration_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token_hash, user_id, expires_at);
  return { token, token_hash };
}

export function getRegistrationToken(db, token_hash) {
  return db.prepare('SELECT * FROM registration_tokens WHERE token_hash = ?').get(token_hash);
}

export function markRegistrationTokenUsed(db, token_hash) {
  return db
    .prepare('UPDATE registration_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?')
    .run(token_hash);
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
