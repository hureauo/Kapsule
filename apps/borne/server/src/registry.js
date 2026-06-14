import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let _db = null;

export function openRegistry(dataDir) {
  if (_db) return _db;

  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'registry.sqlite'));

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS local_events (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      origin     TEXT NOT NULL CHECK(origin IN ('hub','local')),
      status     TEXT NOT NULL DEFAULT 'loaded'
                 CHECK(status IN ('loaded','live','closed','pushed','purged')),
      active     INTEGER NOT NULL DEFAULT 0,
      pulled_at  DATETIME,
      pushed_at  DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS push_state (
      event_id    TEXT NOT NULL,
      video_id    TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      uploaded_at DATETIME,
      PRIMARY KEY (event_id, video_id)
    );
  `);

  // Migration douce : ajoute pulled_at/pushed_at si absents (base créée avant phase 3.4)
  const cols = db.pragma('table_info(local_events)').map(c => c.name);
  if (!cols.includes('pulled_at')) db.exec('ALTER TABLE local_events ADD COLUMN pulled_at DATETIME');
  if (!cols.includes('pushed_at')) db.exec('ALTER TABLE local_events ADD COLUMN pushed_at DATETIME');

  _db = db;
  return _db;
}

// Exposé pour les tests : permet de réinitialiser le singleton entre les suites
export function closeRegistry() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getRegistry() {
  if (!_db) throw new Error('Registry non initialisé — appeler openRegistry(dataDir) au démarrage');
  return _db;
}

// --- Helpers métier ---

export function getActiveEvent() {
  return getRegistry().prepare('SELECT * FROM local_events WHERE active = 1 LIMIT 1').get() ?? null;
}

export function listEvents() {
  return getRegistry().prepare('SELECT * FROM local_events ORDER BY created_at DESC').all();
}

export function insertEvent({ id, name, origin, status = 'loaded' }) {
  getRegistry().prepare(
    `INSERT INTO local_events (id, name, origin, status) VALUES (?, ?, ?, ?)`
  ).run(id, name, origin, status);
}

export function setActiveEvent(id) {
  const db = getRegistry();
  db.transaction(() => {
    db.prepare('UPDATE local_events SET active = 0, updated_at = CURRENT_TIMESTAMP').run();
    db.prepare('UPDATE local_events SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  })();
}

export function updateEventStatus(id, status) {
  getRegistry().prepare(
    'UPDATE local_events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(status, id);
}
