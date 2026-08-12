import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
      status       TEXT NOT NULL DEFAULT 'preview'
                   CHECK(status IN ('preview','ready','loaded','live','closed','pushed','processed','waiting')),
      pulled_at    DATETIME,
      pushed_at    DATETIME,
      processed_at DATETIME,
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

    -- Journal des envois d'emails (lien de mot de passe, notifications).
    -- RGPD : ne contient que des emails de COMPTES (clients/admin), jamais d'invité.
    CREATE TABLE IF NOT EXISTS email_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL,
      type            TEXT NOT NULL,
      subject         TEXT,
      status          TEXT NOT NULL DEFAULT 'sent'
                      CHECK(status IN ('sent','failed','skipped')),
      error           TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Bibliothèque de designs (PROJET.md §9bis). RGPD : aucune donnée invité —
    -- un design est une config d'apparence appartenant à un compte client.
    CREATE TABLE IF NOT EXISTS designs (
      id          TEXT PRIMARY KEY,
      owner_id    INTEGER REFERENCES users(id),  -- NULL pour les templates seed
      name        TEXT NOT NULL,
      config_json TEXT NOT NULL,                 -- JSON validé par validateDesign
      is_template INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS design_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id  TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      snapshot   TEXT NOT NULL,                  -- config_json au moment de la sauvegarde
      author     TEXT,                           -- email du user, comme event_versions
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Trace de provenance « cet événement vient du design X » (§9bis « Rafraîchissement
    -- de la borne d'essai », design2). PAS un lien vivant : sert uniquement à retrouver
    -- les événements 'preview' à rafraîchir quand un design source est édité — les
    -- événements non-preview restent des copies figées (invariant §11.26).
    -- RGPD : deux ids, aucune donnée invité.
    CREATE TABLE IF NOT EXISTS event_design_refs (
      event_id   TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      design_id  TEXT NOT NULL,                  -- pas de FK : un design supprimé détache
                                                  -- l'événement, il ne le casse pas
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase B : identité persistante d'une borne physique (Raspberry), distincte
    -- des box_tokens (token = événement, réservé aux bornes d'essai — provisioner
    -- Hub inchangé). Ici le token identifie la MACHINE ; borne_events l'associe à
    -- N événements dans le temps.
    CREATE TABLE IF NOT EXISTS bornes (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      location         TEXT,
      token_hash       TEXT UNIQUE NOT NULL,
      token_clear      TEXT UNIQUE NOT NULL,
      active           INTEGER NOT NULL DEFAULT 1,
      last_seen_at     DATETIME,
      -- Télémétrie du dernier heartbeat — écrasée à chaque battement, pas d'historique.
      agent_version    TEXT,
      disk_free_bytes  INTEGER,
      disk_total_bytes INTEGER,
      clock_skew_ms    INTEGER,
      active_event_id  TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Assignation N-N : une borne peut servir plusieurs événements dans le temps,
    -- un événement peut avoir plusieurs bornes (PROJET.md §13). Table de jonction
    -- plutôt que events.borne_id pour ne pas re-fermer cette possibilité.
    CREATE TABLE IF NOT EXISTS borne_events (
      borne_id   TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (borne_id, event_id)
    );

    -- File de commandes Hub → Borne. La borne n'est jamais joignable directement
    -- (Wi-Fi événement, pas d'entrée réseau) : le Hub dépose une commande, la
    -- borne la récupère et l'acquitte au battement de heartbeat suivant.
    CREATE TABLE IF NOT EXISTS borne_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      borne_id   TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,
      type       TEXT NOT NULL CHECK(type IN ('pull','activate_event','close_event','purge_event')),
      payload    TEXT,
      status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','sent','done','failed')),
      result     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME,
      done_at    DATETIME
    );
  `);

  runMigrations(db);
  seedDesignTemplates(db);

  _db = db;
  return db;
}

// ── Migrations versionées ─────────────────────────────────────────────────────
// Chaque migration est appliquée exactement une fois, tracée dans schema_migrations.
// L'idempotence interne est conservée : safe sur une DB qui aurait appliqué
// ces migrations avant l'existence du tracker.

const MIGRATIONS = [
  {
    version: 1,
    name: '6B.1_add_active_to_users',
    up(db) {
      const cols = db.pragma('table_info(users)').map((c) => c.name);
      if (!cols.includes('active')) {
        db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
      }
    },
  },
  {
    version: 2,
    name: '6C_add_token_clear_to_box_tokens',
    up(db) {
      const cols = db.pragma('table_info(box_tokens)').map((c) => c.name);
      if (!cols.includes('token_clear')) {
        db.exec("ALTER TABLE box_tokens ADD COLUMN token_clear TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 3,
    name: '7A.1_users_superuser_role',
    // SQLite ne supporte pas ALTER COLUMN → reconstruction de table.
    up(db) {
      const needs = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n > 0;
      if (!needs) return;
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
    },
  },
  {
    version: 4,
    name: '7A.1_events_owner_nullable',
    up(db) {
      const ownerCol = db.pragma('table_info(events)').find((c) => c.name === 'owner_id');
      if (!ownerCol || ownerCol.notnull !== 1) return;
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
    },
  },
  {
    version: 5,
    name: '8D_fix_numeric_event_version_authors',
    // Corrige les author stockés comme id numérique pur (ex. "2") dans event_versions.
    // NOT GLOB '*[^0-9]*' cible uniquement les chaînes 100 % numériques (vs '[0-9]*' qui matche "2abc").
    up(db) {
      const badAuthors = db.prepare(
        "SELECT DISTINCT author FROM event_versions WHERE author IS NOT NULL AND author NOT GLOB '*[^0-9]*' AND author != ''"
      ).all();
      if (badAuthors.length === 0) return;
      const fix = db.prepare(
        'UPDATE event_versions SET author = (SELECT email FROM users WHERE id = CAST(? AS INTEGER)) WHERE author = ?'
      );
      for (const { author } of badAuthors) fix.run(author, author);
    },
  },
  {
    version: 6,
    name: 'WA.2_events_status_preview_waiting',
    // SQLite ne supporte pas ALTER COLUMN — reconstruction de la table pour modifier le CHECK.
    // Remplace 'purged' par 'preview' et 'waiting'. Les lignes 'purged' existantes passent en 'waiting'.
    up(db) {
      const currentCheck = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
      ).get()?.sql ?? '';
      if (currentCheck.includes("'preview'")) return; // déjà migré
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        DROP TABLE IF EXISTS events_new;
        CREATE TABLE events_new (
          id           TEXT PRIMARY KEY,
          owner_id     INTEGER REFERENCES users(id),
          name         TEXT NOT NULL,
          event_date   DATE,
          status       TEXT NOT NULL DEFAULT 'draft'
                       CHECK(status IN ('draft','preview','ready','loaded','live','closed','pushed','processed','waiting')),
          pulled_at    DATETIME,
          pushed_at    DATETIME,
          processed_at DATETIME,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO events_new (id, owner_id, name, event_date, status, pulled_at, pushed_at, processed_at, created_at, updated_at)
        SELECT id, owner_id, name, event_date,
          CASE WHEN status = 'purged' THEN 'waiting' ELSE status END,
          pulled_at, pushed_at, processed_at, created_at, updated_at
        FROM events;
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
      db.exec('PRAGMA foreign_keys = ON');
    },
  },
  {
    version: 7,
    name: 'preview_desired_state',
    // État désiré de la borne preview, indépendant de l'état réel du container.
    // 'running' = doit tourner (réconcilié au boot / make vps-up) ; 'stopped' = éteinte
    // volontairement (bouton Hub) ou jamais démarrée. Défaut 'stopped' à la migration
    // (valeur neutre pour les events existants).
    // NB : depuis la suppression de 'draft', POST /api/events provisionne la preview
    // dès la création et passe preview_desired='running' — ce défaut ne vaut donc plus
    // que pour les events déjà présents lors de la migration.
    up(db) {
      const cols = db.pragma('table_info(events)').map((c) => c.name);
      if (!cols.includes('preview_desired')) {
        db.exec("ALTER TABLE events ADD COLUMN preview_desired TEXT NOT NULL DEFAULT 'stopped'");
      }
    },
  },
  {
    version: 8,
    name: 'remove_draft_status',
    // Suppression du statut draft : les événements démarrent directement en preview.
    // SQLite ne supporte pas ALTER COLUMN — reconstruction de la table.
    up(db) {
      const currentCheck = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
      ).get()?.sql ?? '';
      if (!currentCheck.includes("'draft'")) return; // déjà migré
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        DROP TABLE IF EXISTS events_new;
        CREATE TABLE events_new (
          id           TEXT PRIMARY KEY,
          owner_id     INTEGER REFERENCES users(id),
          name         TEXT NOT NULL,
          event_date   DATE,
          status       TEXT NOT NULL DEFAULT 'preview'
                       CHECK(status IN ('preview','ready','loaded','live','closed','pushed','processed','waiting')),
          pulled_at    DATETIME,
          pushed_at    DATETIME,
          processed_at DATETIME,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO events_new (id, owner_id, name, event_date, status, pulled_at, pushed_at, processed_at, created_at, updated_at)
        SELECT id, owner_id, name, event_date,
          CASE WHEN status = 'draft' THEN 'preview' ELSE status END,
          pulled_at, pushed_at, processed_at, created_at, updated_at
        FROM events;
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
      db.exec('PRAGMA foreign_keys = ON');
      // Réajouter la colonne preview_desired (perdue dans la reconstruction)
      const cols = db.pragma('table_info(events)').map((c) => c.name);
      if (!cols.includes('preview_desired')) {
        db.exec("ALTER TABLE events ADD COLUMN preview_desired TEXT NOT NULL DEFAULT 'stopped'");
      }
    },
  },
  {
    version: 9,
    name: 'email_logs',
    // Journal des envois d'emails. Pour les DB déjà existantes (le bloc CREATE TABLE
    // IF NOT EXISTS d'openRegistry ne s'applique qu'aux colonnes nouvelles, mais ici
    // c'est une table entière → idempotent via IF NOT EXISTS).
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_logs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          recipient_email TEXT NOT NULL,
          type            TEXT NOT NULL,
          subject         TEXT,
          status          TEXT NOT NULL DEFAULT 'sent'
                          CHECK(status IN ('sent','failed','skipped')),
          error           TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 10,
    name: 'phaseB_bornes',
    // Entité borne persistante (Phase B) — trois tables entières, donc idempotent
    // via IF NOT EXISTS comme la migration 9 (email_logs) juste au-dessus.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bornes (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          location         TEXT,
          token_hash       TEXT UNIQUE NOT NULL,
          token_clear      TEXT UNIQUE NOT NULL,
          active           INTEGER NOT NULL DEFAULT 1,
          last_seen_at     DATETIME,
          agent_version    TEXT,
          disk_free_bytes  INTEGER,
          disk_total_bytes INTEGER,
          clock_skew_ms    INTEGER,
          active_event_id  TEXT,
          created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS borne_events (
          borne_id   TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,
          event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (borne_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS borne_commands (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          borne_id   TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,
          type       TEXT NOT NULL CHECK(type IN ('pull','activate_event','close_event','purge_event')),
          payload    TEXT,
          status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','sent','done','failed')),
          result     TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          claimed_at DATETIME,
          done_at    DATETIME
        );
      `);
    },
  },
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const { version, name, up } of MIGRATIONS) {
    if (applied.has(version)) continue;
    up(db);
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
  }
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

// Dernier token (par date de création) émis pour un user — sert au garde anti-spam
// du « mot de passe oublié » (ne pas renvoyer un email si un token < 5 min existe déjà).
export function getLatestRegistrationToken(db, user_id) {
  return db
    .prepare('SELECT * FROM registration_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(user_id);
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

// Événements dont la borne preview doit tourner (réconciliation au boot).
export function listEventsPreviewDesired(db) {
  return db.prepare("SELECT * FROM events WHERE preview_desired = 'running'").all();
}

export function insertEvent(db, { id, name, event_date = null }) {
  return db
    .prepare('INSERT INTO events (id, name, event_date) VALUES (?, ?, ?)')
    .run(id, name, event_date);
}

export function updateEvent(db, id, fields) {
  const allowed = ['name', 'event_date', 'status',
    'pulled_at', 'pushed_at', 'processed_at', 'preview_desired'];
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

// ── email_logs ────────────────────────────────────────────────────────────────

export function insertEmailLog(db, { recipient_email, type, subject = null, status = 'sent', error = null }) {
  return db
    .prepare('INSERT INTO email_logs (recipient_email, type, subject, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(recipient_email, type, subject, status, error);
}

export function listEmailLogs(db, { limit = 100 } = {}) {
  return db
    .prepare('SELECT * FROM email_logs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit);
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

// jobs n'a pas de FK ON DELETE CASCADE vers events (event_id est un simple TEXT) :
// à supprimer explicitement lors d'une suppression totale, sinon le worker pourrait
// traiter des jobs orphelins pointant vers un event disparu.
export function deleteJobsForEvent(db, event_id) {
  return db.prepare('DELETE FROM jobs WHERE event_id = ?').run(event_id);
}

// ── designs ───────────────────────────────────────────────────────────────────

export function insertDesign(db, { id, owner_id = null, name, config_json, is_template = 0 }) {
  return db
    .prepare('INSERT INTO designs (id, owner_id, name, config_json, is_template) VALUES (?, ?, ?, ?, ?)')
    .run(id, owner_id, name, config_json, is_template);
}

export function getDesign(db, id) {
  return db.prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

// Visibilité (même principe que listEvents) : le superuser voit tout ;
// un client voit ses designs et les templates publics.
//
// `owner_email` n'est joint QUE pour le superuser (groupement par propriétaire).
// Un design promu en template garde son `owner_id` : la clause client ci-dessous
// le matche donc pour TOUS les clients — joindre l'email dans cette branche le
// divulguerait d'un client à l'autre. Toute colonne ajoutée à ce SELECT doit être
// examinée sous cet angle.
export function listDesigns(db, { userId, isSuperuser }) {
  if (isSuperuser) {
    return db.prepare(`
      SELECT d.*, u.email AS owner_email
      FROM designs d
      LEFT JOIN users u ON u.id = d.owner_id
      ORDER BY d.created_at DESC
    `).all();
  }
  return db
    .prepare('SELECT * FROM designs WHERE owner_id = ? OR is_template = 1 ORDER BY created_at DESC')
    .all(userId);
}

export function updateDesign(db, id, fields) {
  // owner_id volontairement absent : la propriété d'un design ne se transfère pas
  // (une duplication crée une nouvelle ligne). Ne pas laisser ce levier armé.
  const allowed = ['name', 'config_json', 'is_template'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  const updates = keys.map((k) => `${k} = ?`);
  updates.push("updated_at = datetime('now')");
  const values = keys.map((k) => fields[k]);
  db.prepare(`UPDATE designs SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}

export function deleteDesign(db, id) {
  return db.prepare('DELETE FROM designs WHERE id = ?').run(id);
}

// ── design_versions ───────────────────────────────────────────────────────────

export function insertDesignVersion(db, { design_id, snapshot, author = null }) {
  return db
    .prepare('INSERT INTO design_versions (design_id, snapshot, author) VALUES (?, ?, ?)')
    .run(design_id, snapshot, author);
}

// Sans le snapshot : la liste d'historique reste légère.
export function listDesignVersions(db, design_id) {
  return db
    .prepare('SELECT id, design_id, author, created_at FROM design_versions WHERE design_id = ? ORDER BY id DESC')
    .all(design_id);
}

export function getDesignVersion(db, id) {
  return db.prepare('SELECT * FROM design_versions WHERE id = ?').get(id);
}

// ── event_design_refs ────────────────────────────────────────────────────────
// Trace de provenance (§9bis « Rafraîchissement de la borne d'essai »), pas un
// lien vivant. Sert à retrouver les événements 'preview' à rafraîchir.

export function setEventDesignRef(db, { event_id, design_id }) {
  return db.prepare(`
    INSERT INTO event_design_refs (event_id, design_id) VALUES (?, ?)
    ON CONFLICT(event_id) DO UPDATE SET design_id = excluded.design_id, updated_at = CURRENT_TIMESTAMP
  `).run(event_id, design_id);
}

export function deleteEventDesignRef(db, event_id) {
  return db.prepare('DELETE FROM event_design_refs WHERE event_id = ?').run(event_id);
}

// Événements issus d'un design donné, avec leur nom et statut — sert à la fois
// à l'avertissement d'usage de l'éditeur (design2.C) et au rafraîchissement des
// events 'preview' après une édition du design (design2.B).
export function listEventsByDesignSource(db, designId) {
  return db.prepare(`
    SELECT e.id AS event_id, e.name, e.status
    FROM event_design_refs r
    INNER JOIN events e ON e.id = r.event_id
    WHERE r.design_id = ?
    ORDER BY e.name
  `).all(designId);
}

// ── bornes ───────────────────────────────────────────────────────────────────
// Identité persistante d'une borne physique (Phase B). À ne pas confondre avec
// box_tokens (token = événement, réservé aux bornes d'essai).

export function insertBorne(db, { id, name, location = null, token_hash, token_clear }) {
  return db
    .prepare('INSERT INTO bornes (id, name, location, token_hash, token_clear) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, location, token_hash, token_clear);
}

// Sans token_hash ni token_clear — vue liste (onglet Bornes). event_count évite
// un aller-retour séparé pour afficher le nombre d'événements assignés.
export function listBornes(db) {
  return db.prepare(`
    SELECT b.id, b.name, b.location, b.active, b.last_seen_at,
           b.agent_version, b.disk_free_bytes, b.disk_total_bytes, b.clock_skew_ms,
           b.active_event_id, b.created_at,
           (SELECT COUNT(*) FROM borne_events be WHERE be.borne_id = b.id) AS event_count
    FROM bornes b
    ORDER BY b.created_at DESC
  `).all();
}

export function getBorneById(db, id) {
  return db.prepare('SELECT * FROM bornes WHERE id = ?').get(id);
}

// Utilisé par requireBox (auth borne) — cherche par hash, comme getBoxTokenByHash.
export function getBorneByHash(db, token_hash) {
  return db.prepare('SELECT * FROM bornes WHERE token_hash = ?').get(token_hash);
}

export function updateBorne(db, id, fields) {
  const allowed = ['name', 'location', 'active'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  // active normalisé en 0/1 : requireBox teste `if (!borne.active)` — une
  // valeur non booléenne stockée telle quelle (ex. la chaîne "false", venue
  // d'un JSON.parse laxiste côté appelant) resterait *truthy* et une borne
  // « désactivée » continuerait de s'authentifier normalement.
  const values = keys.map((k) => (k === 'active' ? (fields[k] ? 1 : 0) : fields[k]));
  db.prepare(`UPDATE bornes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...values, id);
}

export function deleteBorne(db, id) {
  return db.prepare('DELETE FROM bornes WHERE id = ?').run(id);
}

// Écrit la télémétrie du battement courant (écrase la précédente, pas d'historique).
export function updateBorneHeartbeat(db, id, { agent_version = null, disk_free_bytes = null, disk_total_bytes = null, clock_skew_ms = null, active_event_id = null } = {}) {
  return db.prepare(`
    UPDATE bornes SET
      last_seen_at = CURRENT_TIMESTAMP,
      agent_version = ?, disk_free_bytes = ?, disk_total_bytes = ?,
      clock_skew_ms = ?, active_event_id = ?
    WHERE id = ?
  `).run(agent_version, disk_free_bytes, disk_total_bytes, clock_skew_ms, active_event_id, id);
}

// ── borne_events (assignation N-N) ──────────────────────────────────────────

// Événements assignés à une borne, avec nom/statut — sert la console borne
// (liste des événements pullables) et la fiche admin Hub.
export function listBorneEvents(db, borne_id) {
  return db.prepare(`
    SELECT e.id, e.name, e.status, e.pulled_at
    FROM borne_events be
    INNER JOIN events e ON e.id = be.event_id
    WHERE be.borne_id = ?
    ORDER BY be.created_at DESC
  `).all(borne_id);
}

// Bornes assignées à un événement (onglet Synchro de l'événement, sans token_hash).
export function listEventBornes(db, event_id) {
  return db.prepare(`
    SELECT b.id, b.name, b.location, b.active, b.last_seen_at
    FROM borne_events be
    INNER JOIN bornes b ON b.id = be.borne_id
    WHERE be.event_id = ?
    ORDER BY b.name
  `).all(event_id);
}

// Existence d'une assignation — sert la route d'assignation pour renvoyer un
// 409 propre plutôt que de compter sur l'exception de contrainte PRIMARY KEY.
export function getBorneEvent(db, { borne_id, event_id }) {
  return db.prepare('SELECT * FROM borne_events WHERE borne_id = ? AND event_id = ?').get(borne_id, event_id);
}

export function assignBorneEvent(db, { borne_id, event_id }) {
  return db.prepare('INSERT INTO borne_events (borne_id, event_id) VALUES (?, ?)').run(borne_id, event_id);
}

export function unassignBorneEvent(db, { borne_id, event_id }) {
  return db.prepare('DELETE FROM borne_events WHERE borne_id = ? AND event_id = ?').run(borne_id, event_id);
}

// ── borne_commands (file Hub → Borne) ───────────────────────────────────────

export function insertBorneCommand(db, { borne_id, type, payload = null }) {
  return db
    .prepare('INSERT INTO borne_commands (borne_id, type, payload) VALUES (?, ?, ?)')
    .run(borne_id, type, payload ? JSON.stringify(payload) : null);
}

// Récupère les commandes en attente ET les marque 'sent' dans la foulée
// (transaction) : le heartbeat qui appelle ceci ne doit jamais renvoyer deux
// fois la même commande à un battement suivant qui chevaucherait un retry réseau.
//
// Re-sélectionne après le marquage plutôt que de renvoyer les lignes du SELECT
// initial : celles-ci sont un instantané capturé AVANT l'UPDATE (better-sqlite3
// retourne des objets JS, pas des références vivantes) — les renvoyer telles
// quelles ferait croire à l'appelant que status vaut encore 'pending'.
export function claimPendingCommands(db, borne_id) {
  const claim = db.transaction((borne_id) => {
    const pending = db
      .prepare("SELECT id FROM borne_commands WHERE borne_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(borne_id);
    if (pending.length === 0) return [];
    const mark = db.prepare("UPDATE borne_commands SET status = 'sent', claimed_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const { id } of pending) mark.run(id);
    const ids = pending.map((r) => r.id);
    return db
      .prepare(`SELECT * FROM borne_commands WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`)
      .all(...ids);
  });
  return claim(borne_id);
}

export function completeBorneCommand(db, { id, status, result = null }) {
  return db.prepare(`
    UPDATE borne_commands SET status = ?, result = ?, done_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, id);
}

// 20 dernières commandes (fiche admin Hub) — état le plus récent en premier.
export function listBorneCommands(db, borne_id, { limit = 20 } = {}) {
  return db
    .prepare('SELECT * FROM borne_commands WHERE borne_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(borne_id, limit);
}

// Utilisé par POST /api/sync/borne/commands/:id/result pour vérifier que la
// commande acquittée appartient bien à la borne authentifiée avant de la clore.
export function getBorneCommandById(db, id) {
  return db.prepare('SELECT * FROM borne_commands WHERE id = ?').get(id);
}

// ── seed des templates ────────────────────────────────────────────────────────
// Les 3 thèmes historiques du kiosque, transcrits depuis les blocs data-theme de
// apps/borne/web/src/styles/app.css (valeurs réelles, pas inventées ; les hex à 3
// chiffres du thème sombre sont normalisés en 6 — même couleur, la regex du contrat
// exige 6 ou 8). Insérés une seule fois, à la première ouverture du registre.

const TEMPLATE_DEFAULTS = {
  version: 1,
  radius: 'soft',
  font: 'sans',
  images: {
    start: { mode: 'none', filename: null },
    thanks: { mode: 'none', filename: null },
  },
};

const DESIGN_TEMPLATES = [
  {
    name: 'Cutealism',
    colors: {
      bg: '#FFF8EE', surface: '#FFFFFF', 'surface-alt': '#FDEFD9',
      text: '#0B3B45', 'text-muted': '#5B7B82', 'text-error': '#C0532B',
      primary: '#0388A6', 'primary-soft': '#63D8F2', 'primary-tint': '#E3F7FC',
      accent: '#F27405', 'accent-hover': '#F28705', 'accent-soft': '#F2AC29', 'accent-tint': '#FDE9CF',
      'input-bg': '#FFFFFF', 'input-border': '#F2D2A6', 'input-border-focus': '#0388A6',
      'btn-secondary-bg': '#E3F7FC', 'btn-secondary-hover': '#C8EEF7',
    },
  },
  {
    name: 'Sombre',
    colors: {
      bg: '#111111', surface: '#1e1e1e', 'surface-alt': '#181818',
      text: '#f0f0f0', 'text-muted': '#888888', 'text-error': '#ff6b6b',
      primary: '#e63946', 'primary-soft': '#ff6b6b', 'primary-tint': '#2a1416',
      accent: '#e63946', 'accent-hover': '#c1121f', 'accent-soft': '#e63946', 'accent-tint': '#2a1416',
      'input-bg': '#2d2d2d', 'input-border': '#444444', 'input-border-focus': '#e63946',
      'btn-secondary-bg': '#2d2d2d', 'btn-secondary-hover': '#3a3a3a',
    },
  },
  {
    name: 'Moderne',
    colors: {
      bg: '#f5f6f8', surface: '#ffffff', 'surface-alt': '#eef0f3',
      text: '#1a1d21', 'text-muted': '#6b7280', 'text-error': '#d92d20',
      primary: '#2563eb', 'primary-soft': '#60a5fa', 'primary-tint': '#eaf1fe',
      accent: '#2563eb', 'accent-hover': '#1d4ed8', 'accent-soft': '#2563eb', 'accent-tint': '#eaf1fe',
      'input-bg': '#ffffff', 'input-border': '#d1d5db', 'input-border-focus': '#2563eb',
      'btn-secondary-bg': '#eef0f3', 'btn-secondary-hover': '#e2e5ea',
    },
  },
];

// Config servie à la création d'un design sans config explicite. Dérivée du
// tableau de seed, PAS d'une ligne en base cherchée par nom : `designs.name` est
// éditable (un superuser peut renommer un template), donc s'appuyer dessus
// casserait la création par défaut au premier renommage.
export function defaultDesignConfig() {
  const cutealism = DESIGN_TEMPLATES.find((t) => t.name === 'Cutealism');
  // Clone profond : un spread superficiel partagerait `images` entre les
  // appels — un appelant qui muterait la config renvoyée corromprait le défaut.
  return structuredClone({ ...TEMPLATE_DEFAULTS, colors: cutealism.colors });
}

function seedDesignTemplates(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM designs').get();
  if (n > 0) return;

  const insert = db.prepare(
    'INSERT INTO designs (id, owner_id, name, config_json, is_template) VALUES (?, NULL, ?, ?, 1)'
  );
  const seed = db.transaction(() => {
    for (const { name, colors } of DESIGN_TEMPLATES) {
      insert.run(randomUUID(), name, JSON.stringify({ ...TEMPLATE_DEFAULTS, colors }));
    }
  });
  seed();
}
