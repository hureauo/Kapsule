import { Router } from 'express';
import { mkdirSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import {
  THEMES, QUALITY_KEYS, VIDEO_ORIENTATIONS, DESIGN_ASSET_SLOTS, validateDesign,
} from '@kapsule/core';
import {
  getDb, listEvents, getEvent, insertEvent, updateEvent, insertSyncLog, upsertEventUser,
  getUserByEmail, insertUser, createRegistrationToken, listUsers, getDesign,
  setEventDesignRef, deleteEventDesignRef,
} from '../registry.js';
import { openEventDb, closeEventDb } from '../eventStore.js';
import { META_KEYS, applyEventConfig } from '../eventConfig.js';
import { requireUser, requireOwner } from '../middleware/auth.js';
import { startPreview, deprovisionPreview, slugFor, dockerCli } from '../preview/provisioner.js';
import { triggerPreviewPull } from './previewGallery.js';
import { captureSnapshot, resolveAuthor } from '../versioning.js';
import { deleteEventVersions, deleteEvent, deleteJobsForEvent } from '../registry.js';
import { buildRegistrationUrl } from '../email/url.js';

function requireAdmin(req, res, next) {
  if (req.user.role !== 'superuser') return res.status(403).json({ error: 'Réservé aux admins' });
  next();
}

// Statuts à partir desquels l'édition de contenu (questions, meta) est gelée.
// 'ready' gèle le contenu (config validée), mais autorise encore un retour à 'preview'.
// Les statuts live+ gèlent aussi les transitions de statut (Borne maître ou push effectué).
const CONTENT_FROZEN = new Set(['ready', 'live', 'closed', 'pushed', 'processed', 'waiting']);
const STATUS_FROZEN  = new Set(['live', 'closed', 'pushed', 'processed', 'waiting']);

// Assets du design APPLIQUÉ à un événement (copie snapshot, §11.26) — distinct de
// dataDir/designs/<designId>/ qui est la bibliothèque.
const eventDesignDir = (dataDir, eventId) => join(dataDir, 'events', eventId, 'design');

/**
 * Copie snapshot (§11.26) : matérialise la config + les fichiers d'un design
 * dans le dossier d'un événement, puis écrit `event_meta.design`. Partagé par
 * PUT /:eventId/design (application manuelle) et refreshPreviewEvents (design2,
 * rafraîchissement automatique des events `preview` après édition du design
 * source) — un seul endroit qui copie fichiers + config, pas de duplication.
 *
 * Ne touche PAS event_meta.design_source_id ni event_design_refs : c'est
 * l'appelant qui décide s'il faut (re)poser la provenance ou non.
 *
 * @returns {{ ok: true }|{ ok: false, status: number, error: string }}
 */
export function materializeEventDesign(dataDir, eventId, design) {
  const config = JSON.parse(design.config_json);
  const check = validateDesign(config);
  if (!check.ok) return { ok: false, status: 409, error: `Design invalide : ${check.error}` };

  // Toutes les sources sont vérifiées AVANT de toucher au dossier de
  // l'événement : sortir en erreur après un rmSync détruirait les images du
  // design déjà appliqué, que event_meta référence encore.
  const srcDir = join(dataDir, 'designs', design.id);
  const toCopy = [];
  for (const slot of DESIGN_ASSET_SLOTS) {
    const filename = config.assets?.[slot];
    if (!filename) continue;
    const src = join(srcDir, filename);
    if (!existsSync(src)) {
      return { ok: false, status: 409, error: `Image manquante pour le design : ${slot}` };
    }
    toCopy.push({ src, filename });
  }

  // Le dossier est reconstruit : un asset d'un design précédemment appliqué
  // ne doit pas y survivre.
  const destDir = eventDesignDir(dataDir, eventId);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const { src, filename } of toCopy) {
    copyFileSync(src, join(destDir, filename));
  }

  const edb = openEventDb(eventId, dataDir);
  // `design` n'est PAS dans META_KEYS (§9bis « Sens unique Hub → Borne ») :
  // applyEventConfig l'ignorerait. On écrit donc la clé directement — c'est
  // le seul endroit qui a le droit de le faire.
  edb.prepare(
    'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run('design', JSON.stringify(config));

  return { ok: true };
}

/**
 * Réapplique le design d'un snapshot de version lors d'un restore (§9bis).
 *
 * `design` n'est pas dans META_KEYS, donc applyEventConfig ne le touche pas :
 * cette fonction s'en charge séparément, sur l'edb déjà ouvert par l'appelant.
 * - snapshot avec design valide → écrit event_meta.design, purge du dossier les
 *   images qui ne sont plus référencées.
 * - snapshot sans design (ou invalide) → retire la clé et vide le dossier.
 *
 * Limite assumée : les fichiers eux-mêmes ne sont pas re-téléchargés depuis la
 * bibliothèque. On restaure ce qui est encore dans events/<id>/design/. Une image
 * supprimée entre-temps donne un design dégradé (config restaurée, image absente)
 * plutôt qu'un échec — cohérent avec le fait qu'un design appliqué est une COPIE
 * autonome.
 *
 * `design_source_id` (event_meta) est restauré tel quel depuis le snapshot — la
 * provenance redevient celle de l'époque. `event_design_refs` (registre) N'EST
 * PAS retouché ici : le mettre à jour demanderait de faire transiter `db` jusqu'à
 * cette fonction (aujourd'hui appelée avec seulement `edb`), hors périmètre de
 * design2.B. Conséquence assumée : après un restore, la ref peut pointer vers un
 * design différent de `design_source_id` restauré — au pire un rafraîchissement
 * de borne d'essai manqué ou mal ciblé, jamais une fuite de données ni une
 * altération d'un événement non-preview.
 */
export function restoreEventDesign(dataDir, eventId, edb, snapshot) {
  const destDir = eventDesignDir(dataDir, eventId);
  const raw = snapshot?.meta?.design ?? null;
  const sourceId = snapshot?.meta?.design_source_id ?? null;

  let design = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (validateDesign(parsed).ok) design = parsed;
    } catch { /* design invalide → traité comme absent */ }
  }

  if (!design) {
    edb.prepare("DELETE FROM event_meta WHERE key = 'design'").run();
    edb.prepare("DELETE FROM event_meta WHERE key = 'design_source_id'").run();
    rmSync(destDir, { recursive: true, force: true });
    return;
  }

  edb.prepare(
    'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run('design', JSON.stringify(design));

  if (sourceId) {
    edb.prepare(
      'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run('design_source_id', sourceId);
  } else {
    edb.prepare("DELETE FROM event_meta WHERE key = 'design_source_id'").run();
  }

  // Purge les images du dossier qui ne sont plus référencées par le design restauré.
  const referenced = new Set(
    DESIGN_ASSET_SLOTS.map((slot) => design.assets?.[slot]).filter(Boolean),
  );
  if (existsSync(destDir)) {
    for (const filename of readdirSync(destDir)) {
      if (!referenced.has(filename)) rmSync(join(destDir, filename), { force: true });
    }
  }
}

function isContentFrozen(status) { return CONTENT_FROZEN.has(status); }
function isStatusFrozen(status)  { return STATUS_FROZEN.has(status); }

// Transitions manuelles Hub : depuis chaque statut, les statuts cibles autorisés (§2)
const MANUAL_TRANSITIONS = new Map([
  ['preview', new Set(['ready'])],
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

      // Initialise db.sqlite avec le schéma
      openEventDb(id, dataDir);

      // Provision automatique de la borne preview dès la création (statut démarre en preview)
      try {
        await startPreview(id, docker, dataDir);
        updateEvent(db, id, { preview_desired: 'running' });
      } catch (err) {
        console.error('[preview/start] échec au provisionnement initial pour', id, err.message);
      }

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
      if (isContentFrozen(event.status)) {
        return res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      }
      const { name, event_date } = req.body;
      const fields = {};
      if (name !== undefined) fields.name = name;
      if (event_date !== undefined) fields.event_date = event_date;

      // Champs event_meta : thème, textes du parcours, idle_timeout, consent_text,
      // video_quality, video_orientation
      const { theme, idle_timeout, video_quality, video_orientation } = req.body;
      if (theme !== undefined && !THEMES.includes(theme)) {
        return res.status(400).json({ error: `Thème invalide : ${theme}` });
      }
      if (video_quality !== undefined && !QUALITY_KEYS.includes(video_quality)) {
        return res.status(400).json({ error: `Qualité vidéo invalide : ${video_quality}` });
      }
      if (video_orientation !== undefined && !VIDEO_ORIENTATIONS.includes(video_orientation)) {
        return res.status(400).json({ error: `Orientation vidéo invalide : ${video_orientation}` });
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
      triggerPreviewPull(event.id);
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/events/:eventId/status ───────────────────────────────────────
  router.put('/:eventId/status', requireUser, requireOwner, async (req, res, next) => {
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
          error: `Transition non autorisée : ${event.status} → ${status}. Transitions manuelles : preview↔ready.`,
        });
      }

      const db = getDb();
      updateEvent(db, event.id, { status });

      // preview → ready : éteindre la borne d'essai (container stoppé, données conservées)
      if (event.status === 'preview' && status === 'ready') {
        try {
          const slug = slugFor(event.id);
          if (await docker.running(`preview-${slug}`)) await docker.stop(`preview-${slug}`);
          if (await docker.running(`preview-backend-${slug}`)) await docker.stop(`preview-backend-${slug}`);
          updateEvent(db, event.id, { preview_desired: 'stopped' });
        } catch (err) {
          console.error('[preview/stop] échec au passage en ready pour', event.id, err.message);
        }
      }

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
  // Plus d'appelant UI depuis le retrait du write-back preview (importPreviewConfig supprimé).
  // Conservé volontairement : utilisable via API directe ou futur outillage admin.
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
        registration_url = buildRegistrationUrl(req, token);
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
  // Réservé aux superusers : démarre les containers preview. S'ils n'existent pas
  // encore (événement créé avant l'auto-provisioning, ou provision échouée), on
  // les provisionne à la volée — provisionPreview est idempotent.
  router.post('/:eventId/preview/start', requireUser, requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const slug = slugFor(req.event.id);
      const frontend = `preview-${slug}`;
      const backend  = `preview-backend-${slug}`;
      // État désiré : doit tourner (réconcilié au boot / make vps-up).
      updateEvent(getDb(), req.event.id, { preview_desired: 'running' });
      // startPreview est idempotent : il provisionne si absent, et reprovisionne
      // si le container existe mais que son réseau a disparu (docker.networksOk).
      const wasRunning = await docker.exists(frontend) && await docker.running(frontend);
      await startPreview(req.event.id, docker, dataDir);
      res.json({ up: true, provisioned: !wasRunning });
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
      // État désiré : éteinte volontairement → ne pas relancer au boot / vps-up.
      updateEvent(getDb(), req.event.id, { preview_desired: 'stopped' });
      if (await docker.running(frontend)) await docker.stop(frontend);
      if (await docker.exists(backend) && await docker.running(backend)) await docker.stop(backend);
      res.json({ up: false });
    } catch (err) {
      console.error('[preview/stop]', req.params.eventId, err.message);
      next(Object.assign(err, { _docker: true }));
    }
  });

  // ── DELETE /api/events/:eventId — suppression totale (données + container + ligne registre) ──
  // Réservé aux superusers (requireAdmin) : action destructive et irréversible.
  // requireOwner reste dans la chaîne pour résoudre req.event (et renvoyer 404 si absent)
  // avant la vérification de rôle.
  router.delete('/:eventId', requireUser, requireOwner, requireAdmin, async (req, res, next) => {
    try {
      const event = req.event;
      const { confirm } = req.body;
      if (!confirm || confirm.trim() !== event.name.trim()) {
        return res.status(400).json({ error: 'Confirmation invalide : fournir { confirm: "<nom exact>" }' });
      }

      // Arrêter le container preview avant de supprimer le dossier (best-effort)
      try {
        await deprovisionPreview(event.id, docker, dataDir);
      } catch (err) {
        console.error('[provisioner] échec deprovision pour', event.id, err.message);
      }

      // §11.11 : fermer le handle avant rm -rf
      closeEventDb(event.id);
      const eventDir = join(dataDir, 'events', event.id);
      rmSync(eventDir, { recursive: true, force: true });

      const db = getDb();
      // Journaliser AVANT de supprimer la ligne (sync_log.event_id n'a pas de FK,
      // mais on garde l'ordre logique : trace écrite tant que l'event existe encore).
      insertSyncLog(db, { event_id: event.id, action: 'delete', detail: { name: event.name } });
      // Suppression totale : versions + jobs + ligne registre.
      // box_tokens / event_users / event_versions ont ON DELETE CASCADE sur events(id),
      // donc deleteEvent suffit pour eux ; deleteEventVersions reste explicite par sûreté.
      deleteEventVersions(db, event.id);
      deleteJobsForEvent(db, event.id);
      deleteEvent(db, event.id);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/events/:eventId/design — applique un design à l'événement ─────
  //
  // COPIE SNAPSHOT, JAMAIS RÉFÉRENCE (invariant §11.26) : on recopie la config et
  // les fichiers du design dans l'événement. On garde en plus une TRACE DE
  // PROVENANCE (event_meta.design_source_id + event_design_refs) — pas un lien
  // vivant, juste de quoi retrouver cet événement s'il faut rafraîchir sa borne
  // d'essai plus tard (design2, §9bis « Rafraîchissement de la borne d'essai »).
  router.put('/:eventId/design', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      if (isContentFrozen(event.status)) {
        return res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      }

      const { design_id } = req.body ?? {};
      if (!design_id || typeof design_id !== 'string') {
        return res.status(400).json({ error: 'design_id est requis.' });
      }

      const db = getDb();
      const design = getDesign(db, design_id);
      if (!design) return res.status(404).json({ error: 'Design introuvable' });

      // Même visibilité que la bibliothèque : propriétaire, template, ou superuser.
      const readable = req.user.role === 'superuser'
        || design.is_template === 1
        || design.owner_id === req.user.sub;
      if (!readable) return res.status(403).json({ error: 'Accès interdit' });

      const result = materializeEventDesign(dataDir, event.id, design);
      if (!result.ok) return res.status(result.status).json({ error: result.error });

      const edb = openEventDb(event.id, dataDir);
      edb.prepare(
        'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('design_source_id', design.id);
      setEventDesignRef(db, { event_id: event.id, design_id: design.id });

      captureSnapshot(db, edb, { event_id: event.id, author: resolveAuthor(db, req.user) });

      res.json(withMeta(getEvent(db, event.id), dataDir));
      triggerPreviewPull(event.id);
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/events/:eventId/design — retour aux thèmes figés ───────────
  router.delete('/:eventId/design', requireUser, requireOwner, (req, res, next) => {
    try {
      const event = req.event;
      if (isContentFrozen(event.status)) {
        return res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      }

      const db = getDb();
      const edb = openEventDb(event.id, dataDir);
      edb.prepare('DELETE FROM event_meta WHERE key = ?').run('design');
      edb.prepare('DELETE FROM event_meta WHERE key = ?').run('design_source_id');
      deleteEventDesignRef(db, event.id);

      rmSync(eventDesignDir(dataDir, event.id), { recursive: true, force: true });

      captureSnapshot(db, edb, { event_id: event.id, author: resolveAuthor(db, req.user) });

      res.json(withMeta(getEvent(db, event.id), dataDir));
      triggerPreviewPull(event.id);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
