import { Router } from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import {
  getDb, listEvents, getEvent, insertEvent, updateEvent, insertSyncLog,
} from '../registry.js';
import { openEventDb, closeEventDb } from '../eventStore.js';
import { requireUser, requireOwner } from '../middleware/auth.js';

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

export function makeEventsRouter(dataDir) {
  const router = Router();

  // ── GET /api/events ────────────────────────────────────────────────────────
  router.get('/', requireUser, (req, res) => {
    const db = getDb();
    res.json(listEvents(db, { userId: req.user.sub, role: req.user.role }));
  });

  // ── POST /api/events ───────────────────────────────────────────────────────
  router.post('/', requireUser, (req, res, next) => {
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
    res.json(req.event);
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

      // consent_text et idle_timeout sont écrits dans event_meta de la BD événement
      const { consent_text, idle_timeout } = req.body;
      if (consent_text !== undefined || idle_timeout !== undefined) {
        const evDb = openEventDb(event.id, dataDir);
        const upsert = evDb.prepare(
          'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        );
        if (consent_text !== undefined) upsert.run('consent_text', String(consent_text));
        if (idle_timeout !== undefined) upsert.run('idle_timeout', String(idle_timeout));
      }

      if (Object.keys(fields).length > 0) {
        const db = getDb();
        updateEvent(db, event.id, fields);
      }

      const db = getDb();
      res.json(getEvent(db, event.id));
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
      'SELECT sl.*, b.name as box_name FROM sync_log sl LEFT JOIN boxes b ON b.id = sl.box_id WHERE sl.event_id = ? ORDER BY sl.created_at DESC LIMIT 20'
    ).all(event.id);

    const box = event.box_id
      ? db.prepare('SELECT id, name, last_seen_at FROM boxes WHERE id = ?').get(event.box_id)
      : null;

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
      box,
      jobs: { total: jobs.length, done: jobsDone, failed: jobsFailed, list: jobs },
      sync_log: logs,
    });
  });

  // ── PUT /api/events/:eventId/assign ───────────────────────────────────────
  router.put('/:eventId/assign', requireUser, requireOwner, (req, res, next) => {
    try {
      const { box_id } = req.body;
      if (box_id === undefined) return res.status(400).json({ error: 'box_id requis' });
      const db = getDb();
      updateEvent(db, req.event.id, { box_id });
      res.json(getEvent(db, req.event.id));
    } catch (err) {
      next(err);
    }
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
