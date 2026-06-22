import Database from 'better-sqlite3';
import { DEFAULTS } from './constants.js';

const DEFAULT_QUESTIONS = [
  { text: 'Quel est votre meilleur souvenir avec les mariés ?', max_duration: 60, countdown: 3 },
  { text: 'Quel conseil donneriez-vous au jeune couple ?', max_duration: 60, countdown: 3 },
  { text: 'Racontez une anecdote mémorable !', max_duration: 90, countdown: 3 },
  { text: 'Un message pour dans 10 ans ?', max_duration: 120, countdown: 3 },
];

export function createEventDb(filePath) {
  const db = new Database(filePath);

  // journal_mode=WAL est persistant (stocké dans le fichier) ; foreign_keys est par-connexion
  // → les deux serveurs (Borne, Hub) doivent re-poser foreign_keys à chaque new Database()
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS questions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      text         TEXT    NOT NULL,
      max_duration INTEGER NOT NULL DEFAULT ${DEFAULTS.MAX_DURATION_S},
      countdown    INTEGER NOT NULL DEFAULT ${DEFAULTS.COUNTDOWN_S},
      order_index  INTEGER NOT NULL DEFAULT 0,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      guest_name   TEXT,
      consent_at   DATETIME NOT NULL,
      started_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS videos (
      id            TEXT PRIMARY KEY,
      session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id   INTEGER REFERENCES questions(id) ON DELETE SET NULL,
      question_text TEXT    NOT NULL,
      filename      TEXT    NOT NULL UNIQUE,
      mime_type     TEXT    NOT NULL DEFAULT 'video/mp4',
      size          INTEGER,
      checksum      TEXT,
      recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS derived (
      video_id   TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      thumbnail  TEXT,
      duration_s REAL,
      width      INTEGER,
      height     INTEGER,
      probed_at  DATETIME
    );

    CREATE TABLE IF NOT EXISTS event_users (
      email         TEXT PRIMARY KEY,
      password_hash TEXT,
      roles         TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS local_overrides (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed 4 questions par défaut si la table est vide
  const count = db.prepare('SELECT COUNT(*) as n FROM questions').get().n;
  if (count === 0) {
    const insert = db.prepare(
      'INSERT INTO questions (text, max_duration, countdown, order_index) VALUES (?, ?, ?, ?)'
    );
    const seedAll = db.transaction(() => {
      DEFAULT_QUESTIONS.forEach((q, i) => insert.run(q.text, q.max_duration, q.countdown, i));
    });
    seedAll();
  }

  return db;
}
