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
                    CHECK(role IN ('superuser','client')),
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

    CREATE TABLE IF NOT EXISTS box_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      token_hash   TEXT UNIQUE NOT NULL,
      token_clear  TEXT UNIQUE NOT NULL DEFAULT '',
      label        TEXT,
      location     TEXT,
      is_preview   INTEGER NOT NULL DEFAULT 0,
      last_seen_at DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER REFERENCES users(id),
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

    CREATE TABLE IF NOT EXISTS event_users (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      roles      TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (event_id, user_id)
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
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      snapshot   TEXT NOT NULL,
      summary    TEXT NOT NULL,
      author     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration 6B.1: add 'active' to users
  const userCols = db.pragma('table_info(users)').map((c) => c.name);
  if (!userCols.includes('active')) {
    db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

  // Migration 6C: add 'token_clear' to box_tokens
  const boxCols = db.pragma('table_info(box_tokens)').map((c) => c.name);
  if (!boxCols.includes('token_clear')) {
    db.exec("ALTER TABLE box_tokens ADD COLUMN token_clear TEXT NOT NULL DEFAULT ''");
  }

  // Migration 7A.1: renommer role 'admin' → 'superuser' + relâcher owner_id
  // SQLite ne supporte pas ALTER COLUMN ni DROP COLUMN de façon portable.
  // On reconstruit les deux tables concernées si elles portent encore l'ancien schéma.
  const needsUsersMigration = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n > 0;
  if (needsUsersMigration) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS users_new;
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        name          TEXT,
        role          TEXT NOT NULL DEFAULT 'client'
                      CHECK(role IN ('superuser','client')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_new SELECT
        id, email, password_hash, name,
        CASE WHEN role = 'admin' THEN 'superuser' ELSE role END,
        active, created_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Migration 7A.1: owner_id nullable sur events (reconstruit si NOT NULL)
  const ownerCol = db.pragma('table_info(events)').find(c => c.name === 'owner_id');
  if (ownerCol && ownerCol.notnull === 1) {
    db.exec(`
      DROP TABLE IF EXISTS events_new;
      CREATE TABLE events_new (
        id           TEXT PRIMARY KEY,
        owner_id     INTEGER REFERENCES users(id),
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
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
    `);
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
    .prepare('SELECT id, email, name, role, active, created_at, password_hash FROM users ORDER BY created_at DESC')
    .all();
}

export function countSuperusers(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superuser' AND active = 1").get().n;
}

export function updateUser(db, id, fields) {
  const allowed = ['active', 'name', 'password_hash', 'role'];
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
  if (role === 'superuser') return db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  return db.prepare(`
    SELECT e.* FROM events e
    INNER JOIN event_users eu ON eu.event_id = e.id
    WHERE eu.user_id = ?
    ORDER BY e.created_at DESC
  `).all(userId);
}

export function getEvent(db, id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

export function insertEvent(db, { id, name, event_date = null }) {
  return db
    .prepare('INSERT INTO events (id, name, event_date) VALUES (?, ?, ?)')
    .run(id, name, event_date);
}

export function updateEvent(db, id, fields) {
  const allowed = ['name', 'event_date', 'status',
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

// ── box_tokens ────────────────────────────────────────────────────────────────

export function insertBoxToken(db, { event_id, token_hash, token_clear, label = null, location = null, is_preview = 0 }) {
  return db
    .prepare('INSERT INTO box_tokens (event_id, token_hash, token_clear, label, location, is_preview) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event_id, token_hash, token_clear, label, location, is_preview ? 1 : 0);
}

export function listBoxTokensByEvent(db, event_id) {
  return db
    .prepare('SELECT id, event_id, token_clear, label, location, is_preview, last_seen_at, created_at FROM box_tokens WHERE event_id = ? ORDER BY created_at DESC')
    .all(event_id);
}

export function listAllBoxTokens(db) {
  return db.prepare(`
    SELECT bt.id, bt.event_id, bt.token_clear, bt.label, bt.location,
           bt.is_preview, bt.last_seen_at, bt.created_at,
           e.name AS event_name
    FROM box_tokens bt
    LEFT JOIN events e ON e.id = bt.event_id
    ORDER BY bt.created_at DESC
  `).all();
}

export function getBoxTokenById(db, id) {
  return db.prepare('SELECT * FROM box_tokens WHERE id = ?').get(id);
}

export function getBoxTokenByHash(db, token_hash) {
  return db.prepare('SELECT * FROM box_tokens WHERE token_hash = ?').get(token_hash);
}

export function deleteBoxToken(db, id) {
  return db.prepare('DELETE FROM box_tokens WHERE id = ?').run(id);
}

export function updateBoxToken(db, id, fields) {
  const allowed = ['label', 'location'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  db.prepare(`UPDATE box_tokens SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

export function updateBoxTokenSeen(db, id) {
  return db.prepare('UPDATE box_tokens SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

// ── event_users ───────────────────────────────────────────────────────────────

export function listEventUsers(db, event_id) {
  return db.prepare(`
    SELECT eu.user_id, eu.roles, u.email, u.name, u.active
    FROM event_users eu
    INNER JOIN users u ON u.id = eu.user_id
    WHERE eu.event_id = ?
    ORDER BY u.email
  `).all(event_id);
}

export function upsertEventUser(db, { event_id, user_id, roles }) {
  return db.prepare(`
    INSERT INTO event_users (event_id, user_id, roles)
    VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET roles = excluded.roles
  `).run(event_id, user_id, JSON.stringify(roles));
}

export function deleteEventUser(db, { event_id, user_id }) {
  return db.prepare('DELETE FROM event_users WHERE event_id = ? AND user_id = ?').run(event_id, user_id);
}

export function getEventUser(db, { event_id, user_id }) {
  return db.prepare('SELECT * FROM event_users WHERE event_id = ? AND user_id = ?').get(event_id, user_id);
}

// ── sync_log ─────────────────────────────────────────────────────────────────

export function insertSyncLog(db, { event_id = null, action, detail = null }) {
  return db
    .prepare('INSERT INTO sync_log (event_id, action, detail) VALUES (?, ?, ?)')
    .run(event_id, action, detail ? JSON.stringify(detail) : null);
}

// ── event_versions ────────────────────────────────────────────────────────────

export function insertEventVersion(db, { event_id, snapshot, summary, author = null }) {
  return db
    .prepare('INSERT INTO event_versions (event_id, snapshot, summary, author) VALUES (?, ?, ?, ?)')
    .run(event_id, JSON.stringify(snapshot), summary, author);
}

export function listEventVersions(db, event_id) {
  return db
    .prepare('SELECT id, event_id, summary, author, created_at FROM event_versions WHERE event_id = ? ORDER BY created_at DESC, id DESC')
    .all(event_id);
}

export function getEventVersion(db, id) {
  const row = db.prepare('SELECT * FROM event_versions WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

export function getPreviousEventVersion(db, event_id, current_id) {
  const row = db
    .prepare('SELECT * FROM event_versions WHERE event_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .get(event_id, current_id);
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

export function deleteEventVersions(db, event_id) {
  return db.prepare('DELETE FROM event_versions WHERE event_id = ?').run(event_id);
}
