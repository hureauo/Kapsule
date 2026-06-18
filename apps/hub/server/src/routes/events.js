import { Router } from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { THEMES, TEXT_FIELDS } from '@kapsule/core';
import {
  getDb, listEvents, getEvent, insertEvent, updateEvent, insertSyncLog,
  getUserByEmail, insertUser, createRegistrationToken,
} from '../registry.js';
import { openEventDb, closeEventDb } from '../eventStore.js';
import { requireUser, requireOwner } from '../middleware/auth.js';

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux admins' });
  next();
}

// Statuts à partir desquels l'édition est gelée (Hub connaît un statut ≥ live)
const FROZEN_STATUSES = new Set(['live', 'closed', 'pushed', 'processed', 'purged']);

function isFrozen(status) {
  return FROZEN_STATUSES.has(status);
}

// Transitions manuelles autorisées : draft↔ready uniquement
const MANUAL_TRANSITIONS = new Map([
  ['draft', 'ready'],
  ['ready', 'draft'],
]);

// Enrichit un événement avec ses event_meta (thème, textes, idle_timeout).
// Retourne null si l'event_meta n'existe pas encore (événement tout juste créé).
function withMeta(event, dataDir) {
  try {
    const edb = openEventDb(event.id, dataDir);
    const rows = edb.prepare('SELECT key, value FROM event_meta').all();
    const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { ...event, meta };
  } catch {
    return event;
  }
}

export function makeEventsRouter(dataDir) {
  const router = Router();

  // ── GET /api/events ────────────────────────────────────────────────────────
  router.get('/', requireUser, (req, res) => {
    const db = getDb();
    res.json(listEvents(db, { userId: req.user.sub, role: req.user.role }));
  });

  // ── POST /api/events ───────────────────────────────────────────────────────
  router.post('/', requireUser, requireAdmin, (req, res, next) => {
    try {
      const { name, event_date } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name requis' });
      }
      const id = uuidv4();
      const eventDir = join(dataDir, 'events', id);
      mkdirSync(eventDir, { recursive: true });

      const db = getDb();
      insertEvent(db, { id, owner_id: req.user.sub, name: name.trim(), event_date: event_date ?? null });

      // Initialise db.sqlite avec le schéma + 4 questions par défaut
      openEventDb(id, dataDir);

      res.status(201).json(getEvent(db, id));
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/events/:eventId ───────────────────────────────────────────────
  router.get('/:eventId', requireUser, requireOwner, (req, res) => {
    res.json(withMeta(req.event, dataDir));
  });

  // ── PUT /api/events/:eventId ───────────────────────────────────────────────
  router.put('/:eventId', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      if (isFrozen(event.status)) {
        return res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      }
      const { name, event_date } = req.body;
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (event_date !== undefined) fields.event_date = event_date;

      // Champs event_meta : thème, textes du parcours, idle_timeout, consent_text
      const { theme, idle_timeout } = req.body;
      const metaUpdates = {};
      if (theme !== undefined) {
        if (!THEMES.includes(theme)) return res.status(400).json({ error: `Thème invalide : ${theme}` });
        metaUpdates.theme = theme;
      }
      if (idle_timeout !== undefined) metaUpdates.idle_timeout = String(idle_timeout);
      for (const key of Object.keys(TEXT_FIELDS)) {
        if (req.body[key] !== undefined) metaUpdates[key] = String(req.body[key]);
      }
      if (Object.keys(metaUpdates).length > 0) {
        const evDb = openEventDb(event.id, dataDir);
        const upsert = evDb.prepare(
          'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        );
        for (const [k, v] of Object.entries(metaUpdates)) upsert.run(k, v);
      }

      if (Object.keys(fields).length > 0) {
        const db = getDb();
        updateEvent(db, event.id, fields);
      }

      const db = getDb();
      res.json(withMeta(getEvent(db, event.id), dataDir));
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/events/:eventId/status ───────────────────────────────────────
  router.put('/:eventId/status', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'status requis' });

      if (isFrozen(event.status)) {
        return res.status(409).json({ error: `Transition impossible : événement en statut ${event.status}` });
      }

      const allowed = MANUAL_TRANSITIONS.get(event.status);
      if (allowed !== status) {
        return res.status(400).json({
          error: `Transition non autorisée : ${event.status} → ${status}. Seules draft↔ready sont manuelles.`,
        });
      }

      const db = getDb();
      updateEvent(db, event.id, { status });
      res.json(getEvent(db, event.id));
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/events/:eventId/sync — données synchro (jobs + sync_log) ──────
  router.get('/:eventId/sync', requireUser, requireOwner, (req, res) => {
    const db = getDb();
    const event = req.event;

    const jobs = db.prepare(
      'SELECT * FROM jobs WHERE event_id = ? ORDER BY created_at ASC'
    ).all(event.id);

    const logs = db.prepare(
      'SELECT id, event_id, action, detail, created_at FROM sync_log WHERE event_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(event.id);

    // Tokens de borne liés à cet événement (modèle 6C : token = événement)
    const tokens = db.prepare(
      'SELECT id, event_id, label, location, is_preview, last_seen_at, created_at FROM box_tokens WHERE event_id = ?'
    ).all(event.id);

    const jobsDone = jobs.filter(j => j.status === 'done').length;
    const jobsFailed = jobs.filter(j => j.status === 'failed').length;

    res.json({
      event: {
        id: event.id,
        status: event.status,
        pulled_at: event.pulled_at,
        pushed_at: event.pushed_at,
        processed_at: event.processed_at,
        purged_at: event.purged_at,
      },
      tokens,
      jobs: { total: jobs.length, done: jobsDone, failed: jobsFailed, list: jobs },
      sync_log: logs,
    });
  });

  // ── POST /api/events/:eventId/config — import config depuis UI Hub (admin) ──
  // body: { mode: 'overwrite'|'merge', questions: [...], meta: { theme, ... } }
  // Protégé par requireUser (JWT) — distinct de POST /api/sync/events/:id/config (box token).
  router.post('/:eventId/config', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      const FROZEN = new Set(['live', 'closed', 'pushed', 'processed', 'purged']);
      if (FROZEN.has(event.status)) {
        return res.status(409).json({ error: `Import impossible : événement en statut ${event.status}` });
      }

      const { mode, questions, meta } = req.body;
      if (!['overwrite', 'merge'].includes(mode)) {
        return res.status(400).json({ error: 'mode doit être overwrite ou merge' });
      }

      const META_KEYS = ['theme', 'idle_timeout', ...Object.keys(TEXT_FIELDS)];
      const edb = openEventDb(event.id, dataDir);
      const upsert = edb.prepare(
        'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      );

      if (meta && typeof meta === 'object') {
        for (const key of META_KEYS) {
          if (meta[key] === undefined) continue;
          if (mode === 'merge') {
            const existing = edb.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value;
            if (existing && existing.trim() !== '') continue;
          }
          if (key === 'theme' && !THEMES.includes(meta[key])) continue;
          upsert.run(key, String(meta[key]));
        }
      }

      if (Array.isArray(questions)) {
        if (mode === 'overwrite') edb.prepare('DELETE FROM questions').run();
        const existingTexts = new Set(edb.prepare('SELECT text FROM questions').all().map(q => q.text));
        const insert = edb.prepare(
          'INSERT INTO questions (text, max_duration, countdown, order_index, enabled) VALUES (?, ?, ?, ?, ?)'
        );
        const maxRow = edb.prepare('SELECT MAX(order_index) as m FROM questions').get();
        let nextOrder = (maxRow?.m ?? -1) + 1;
        for (const q of questions) {
          if (!q.text || typeof q.text !== 'string') continue;
          if (mode === 'merge' && existingTexts.has(q.text)) continue;
          insert.run(q.text.slice(0, 500), q.max_duration ?? 60, q.countdown ?? 3, nextOrder++, q.enabled !== undefined ? (q.enabled ? 1 : 0) : 1);
        }
      }

      const db = getDb();
      insertSyncLog(db, { event_id: event.id, action: 'config_import', detail: { mode, questions: questions?.length ?? 0 } });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── PUT /api/events/:eventId/owner — assigne un client (crée le compte si absent) ──
  router.put('/:eventId/owner', requireUser, requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const { email } = req.body;
      if (!email || !email.trim()) return res.status(400).json({ error: 'email requis' });

      const db = getDb();
      let user = getUserByEmail(db, email.trim());
      let registration_url = null;
      let created = false;

      if (!user) {
        const result = insertUser(db, { email: email.trim(), role: 'client' });
        user = { id: result.lastInsertRowid, email: email.trim() };
        const { token } = createRegistrationToken(db, { user_id: user.id });
        registration_url = `${req.protocol}://${req.get('host')}/register?token=${token}`;
        created = true;
      }

      db.prepare('UPDATE events SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(user.id, req.params.eventId);

      res.json({
        event: getEvent(db, req.params.eventId),
        owner: { id: user.id, email: user.email },
        created,
        registration_url,
      });
    } catch (err) { next(err); }
  });

  // ── DELETE /api/events/:eventId — purge RGPD ──────────────────────────────
  router.delete('/:eventId', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      const { confirm } = req.body;
      if (!confirm || confirm.trim() !== event.name.trim()) {
        return res.status(400).json({ error: 'Confirmation invalide : fournir { confirm: "<nom exact>" }' });
      }

      // §11.11 : fermer le handle avant rm -rf
      closeEventDb(event.id);
      const eventDir = join(dataDir, 'events', event.id);
      rmSync(eventDir, { recursive: true, force: true });

      const db = getDb();
      updateEvent(db, event.id, { status: 'purged', purged_at: new Date().toISOString() });
      insertSyncLog(db, { event_id: event.id, action: 'purge', detail: { name: event.name } });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
