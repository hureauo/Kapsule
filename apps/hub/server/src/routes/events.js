import { Router } from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { THEMES } from '@kapsule/core';
import {
  getDb, listEvents, getEvent, insertEvent, updateEvent, insertSyncLog, upsertEventUser,
  getUserByEmail, insertUser, createRegistrationToken, listUsers,
} from '../registry.js';
import { openEventDb, closeEventDb } from '../eventStore.js';
import { META_KEYS, applyEventConfig } from '../eventConfig.js';
import { requireUser, requireOwner } from '../middleware/auth.js';
import { provisionPreview, deprovisionPreview, slugFor, dockerCli } from '../preview/provisioner.js';
import { captureSnapshot, resolveAuthor } from '../versioning.js';
import { deleteEventVersions } from '../registry.js';

function requireAdmin(req, res, next) {
  if (req.user.role !== 'superuser') return res.status(403).json({ error: 'Réservé aux admins' });
  next();
}

// Statuts à partir desquels l'édition de contenu (questions, meta) est gelée.
// 'ready' gèle le contenu (config validée), mais autorise encore un retour à 'preview'.
// Les statuts live+ gèlent aussi les transitions de statut (Borne maître ou push effectué).
const CONTENT_FROZEN = new Set(['ready', 'live', 'closed', 'pushed', 'processed', 'waiting']);
const STATUS_FROZEN  = new Set(['live', 'closed', 'pushed', 'processed', 'waiting']);

function isContentFrozen(status) { return CONTENT_FROZEN.has(status); }
function isStatusFrozen(status)  { return STATUS_FROZEN.has(status); }

// Transitions manuelles Hub : depuis chaque statut, les statuts cibles autorisés (§2)
const MANUAL_TRANSITIONS = new Map([
  ['draft',   new Set(['preview'])],
  ['preview', new Set(['draft', 'ready'])],
  ['ready',   new Set(['preview'])],
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

export function makeEventsRouter(dataDir, { docker = dockerCli } = {}) {
  const router = Router();

  // ── GET /api/events ────────────────────────────────────────────────────────
  router.get('/', requireUser, (req, res) => {
    const db = getDb();
    res.json(listEvents(db, { userId: req.user.sub, role: req.user.role }));
  });

  // ── POST /api/events ───────────────────────────────────────────────────────
  router.post('/', requireUser, requireAdmin, async (req, res, next) => {
    try {
      const { name, event_date } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name requis' });
      }
      const id = uuidv4();
      const eventDir = join(dataDir, 'events', id);
      mkdirSync(eventDir, { recursive: true });

      const db = getDb();
      insertEvent(db, { id, name: name.trim(), event_date: event_date ?? null });

      // Assigne le créateur avec admin_borne
      upsertEventUser(db, { event_id: id, user_id: req.user.sub, roles: ['admin_borne'] });

      // Assigne tous les superusers actifs avec tous les rôles borne
      const superusers = listUsers(db).filter(u => u.role === 'superuser' && u.active && u.id !== req.user.sub);
      for (const su of superusers) {
        upsertEventUser(db, { event_id: id, user_id: su.id, roles: ['admin_borne', 'tech_borne', 'general'] });
      }

      // Initialise db.sqlite avec le schéma + 4 questions par défaut
      openEventDb(id, dataDir);

      // Auto-provisioning preview (best-effort : un échec Docker ne bloque pas la création)
      let preview_url = null;
      try {
        preview_url = await provisionPreview(id, docker);
      } catch (err) {
        console.error('[provisioner] échec provision preview pour', id, err.message);
      }

      res.status(201).json({ ...getEvent(db, id), preview_url });
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
      if (isContentFrozen(event.status)) {
        return res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      }
      const { name, event_date } = req.body;
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (event_date !== undefined) fields.event_date = event_date;

      // Champs event_meta : thème, textes du parcours, idle_timeout, consent_text
      const { theme, idle_timeout } = req.body;
      if (theme !== undefined && !THEMES.includes(theme)) {
        return res.status(400).json({ error: `Thème invalide : ${theme}` });
      }
      const metaKeys = META_KEYS.filter(k => req.body[k] !== undefined);
      if (metaKeys.length > 0) {
        const meta = Object.fromEntries(metaKeys.map(k => [k, req.body[k]]));
        const evDb = openEventDb(event.id, dataDir);
        applyEventConfig(evDb, { mode: 'overwrite', meta });
      }

      if (Object.keys(fields).length > 0) {
        const db = getDb();
        updateEvent(db, event.id, fields);
      }

      const db = getDb();
      const edb = openEventDb(event.id, dataDir);
      captureSnapshot(db, edb, { event_id: event.id, author: resolveAuthor(db, req.user) });

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

      if (isStatusFrozen(event.status)) {
        return res.status(409).json({ error: `Transition impossible : événement en statut ${event.status}` });
      }

      const allowed = MANUAL_TRANSITIONS.get(event.status);
      if (!allowed || !allowed.has(status)) {
        return res.status(400).json({
          error: `Transition non autorisée : ${event.status} → ${status}. Transitions manuelles : draft↔preview, preview↔ready.`,
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
      if (isContentFrozen(event.status)) {
        return res.status(409).json({ error: `Import impossible : événement en statut ${event.status}` });
      }

      const { mode, questions, meta } = req.body;
      if (!['overwrite', 'merge'].includes(mode)) {
        return res.status(400).json({ error: 'mode doit être overwrite ou merge' });
      }

      const edb = openEventDb(event.id, dataDir);
      applyEventConfig(edb, { mode, meta, questions });

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

      upsertEventUser(db, { event_id: req.params.eventId, user_id: user.id, roles: ['admin_borne'] });
      db.prepare('UPDATE events SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.eventId);

      res.json({
        event: getEvent(db, req.params.eventId),
        owner: { id: user.id, email: user.email },
        created,
        registration_url,
      });
    } catch (err) { next(err); }
  });

  // ── POST /api/events/:eventId/preview/token ──────────────────────────────
  // Génère un JWT scopé à cet événement avec le rôle `general`.
  // Accessible au propriétaire (client) et aux superusers — pas uniquement superuser.
  // body optionnel : { expires_in: '7d' }
  router.post('/:eventId/preview/token', requireUser, requireOwner, (req, res) => {
    const jwtSecret = process.env.JWT_SECRET ?? 'change-me';
    const expiresIn = req.body?.expires_in ?? '7d';
    const token = jwt.sign(
      { roles: ['general'], event_id: req.event.id },
      jwtSecret,
      { expiresIn }
    );

    const slug = slugFor(req.event.id);
    const domain = process.env.EDGE_DOMAIN ?? 'kapsule.hureau.com';
    const preview_url = `https://essai-${slug}.${domain}?token=${token}`;

    res.json({ token, preview_url, expires_in: expiresIn });
  });

  // ── GET /api/events/:eventId/preview/status ───────────────────────────────
  // Retourne l'état du container preview (up/down) via docker inspect.
  // Asymétrie de droits intentionnelle : status/token accessibles au propriétaire
  // (le client peut consulter l'état et générer un lien d'essai), tandis que
  // start/stop sont réservés aux superusers (contrôle des ressources Docker).
  router.get('/:eventId/preview/status', requireUser, requireOwner, async (req, res, next) => {
    try {
      const slug = slugFor(req.event.id);
      const domain = process.env.EDGE_DOMAIN ?? 'kapsule.hureau.com';
      const preview_url = `https://essai-${slug}.${domain}`;
      const up = await docker.running(`preview-${slug}`);
      res.json({ up, preview_url, slug });
    } catch (err) { next(err); }
  });

  // ── POST /api/events/:eventId/preview/start ───────────────────────────────
  // Réservé aux superusers : démarre les containers preview existants (pas de provision).
  router.post('/:eventId/preview/start', requireUser, requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const slug = slugFor(req.event.id);
      const frontend = `preview-${slug}`;
      const backend  = `preview-backend-${slug}`;
      if (!await docker.exists(frontend)) {
        return res.status(404).json({ error: 'container_not_found', detail: 'Recréer l\'événement pour reprovisionner la preview.' });
      }
      if (!await docker.running(frontend)) await docker.start(frontend);
      if (await docker.exists(backend) && !await docker.running(backend)) await docker.start(backend);
      res.json({ up: true });
    } catch (err) {
      console.error('[preview/start]', req.params.eventId, err.message);
      next(Object.assign(err, { _docker: true }));
    }
  });

  // ── POST /api/events/:eventId/preview/stop ────────────────────────────────
  // Réservé aux superusers : arrête les containers sans les supprimer.
  router.post('/:eventId/preview/stop', requireUser, requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const slug = slugFor(req.event.id);
      const frontend = `preview-${slug}`;
      const backend  = `preview-backend-${slug}`;
      if (await docker.running(frontend)) await docker.stop(frontend);
      if (await docker.exists(backend) && await docker.running(backend)) await docker.stop(backend);
      res.json({ up: false });
    } catch (err) {
      console.error('[preview/stop]', req.params.eventId, err.message);
      next(Object.assign(err, { _docker: true }));
    }
  });

  // ── DELETE /api/events/:eventId — purge RGPD ──────────────────────────────
  router.delete('/:eventId', requireUser, requireOwner, async (req, res, next) => {
    try {
      const event = req.event;
      const { confirm } = req.body;
      if (!confirm || confirm.trim() !== event.name.trim()) {
        return res.status(400).json({ error: 'Confirmation invalide : fournir { confirm: "<nom exact>" }' });
      }

      // Arrêter le container preview avant de supprimer le dossier (best-effort)
      try {
        await deprovisionPreview(event.id, docker);
      } catch (err) {
        console.error('[provisioner] échec deprovision pour', event.id, err.message);
      }

      // §11.11 : fermer le handle avant rm -rf
      closeEventDb(event.id);
      const eventDir = join(dataDir, 'events', event.id);
      rmSync(eventDir, { recursive: true, force: true });

      const db = getDb();
      deleteEventVersions(db, event.id);
      updateEvent(db, event.id, { status: 'waiting' });
      insertSyncLog(db, { event_id: event.id, action: 'purge', detail: { name: event.name } });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
