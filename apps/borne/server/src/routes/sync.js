import { Router } from 'express';
import { rmSync, existsSync, unlink } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { getRegistry, getActiveEvent, updateEventStatus } from '../registry.js';
import { closeEventDb, getActiveEventDb } from '../eventDb.js';
import { getLastPull, pullMyEvent } from '../sync/pull.js';
import { pushEvent, pushConfig, getPushState } from '../sync/push.js';
import { hubFetchJson } from '../sync/hubClient.js';

const META_HASH_KEYS = ['theme', 'idle_timeout', 'welcome_title', 'welcome_subtitle', 'name_prompt', 'consent_text', 'consent_details', 'thanks_text'];

function configHash(questions, meta) {
  const q = questions.map(({ text, max_duration, countdown, order_index, enabled }) =>
    ({ text, max_duration, countdown, order_index, enabled })
  );
  const m = Object.fromEntries(META_HASH_KEYS.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
  return createHash('sha256').update(JSON.stringify({ questions: q, meta: m })).digest('hex').slice(0, 8);
}

function isPreviewMode(cfg) {
  return !!(cfg.previewMode ?? config.previewMode) || !!(getActiveEvent()?.is_preview);
}

function getLocalConfig(dataDir) {
  const active = getActiveEvent();
  if (!active) return null;
  try {
    const db = getActiveEventDb(dataDir, active);
    const questions = db.prepare(
      'SELECT id, text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index, id'
    ).all();
    const metaRows = db.prepare('SELECT key, value FROM event_meta').all();
    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
    return { questions, meta, hash: configHash(questions, meta) };
  } catch {
    return null;
  }
}

export function makeSyncRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireTech;

  // ── GET /api/sync/status ──────────────────────────────────────────────────────
  // Retourne connexion Hub, token masqué, config locale, état du push en cours.
  router.get('/sync/status', auth, (req, res) => {
    const hubUrl = cfg.hubUrl || config.hubUrl || null;
    const boxToken = cfg.boxToken || config.boxToken || null;
    res.json({
      online: !!hubUrl,
      hubUrl,
      token: boxToken ? `${boxToken.slice(0, 8)}…` : null,
      isPreview: isPreviewMode(cfg),
      lastPull: getLastPull(),
      localConfig: getLocalConfig(dataDir),
      push: getPushState(),
    });
  });

  // ── GET /api/sync/hub-config ──────────────────────────────────────────────────
  // Récupère la config actuelle du Hub (bundle) pour comparaison avec le local.
  router.get('/sync/hub-config', auth, async (req, res, next) => {
    try {
      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });
      const bundle = await hubFetchJson(`/api/sync/events/${active.id}/bundle`);
      const questions = bundle.questions;
      const meta = bundle.event.meta ?? {};
      res.json({ questions, meta, hash: configHash(questions, meta) });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/token ──────────────────────────────────────────────────────
  // Change le BOX_TOKEN à chaud (sans redémarrer). Déclenche un pull immédiat.
  router.post('/sync/token', auth, async (req, res, next) => {
    try {
      const { token } = req.body ?? {};
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return res.status(400).json({ error: 'token requis' });
      }
      config.boxToken = token.trim();
      cfg.boxToken = token.trim();
      // Pull immédiat pour charger l'événement associé au nouveau token
      await pullMyEvent(dataDir).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/pull ───────────────────────────────────────────────────────
  // Pull manuel : attend la fin et retourne le résultat.
  router.post('/sync/pull', auth, async (req, res, next) => {
    try {
      const pulled = await pullMyEvent(dataDir);
      res.json({ ok: true, pulled: pulled > 0, localConfig: getLocalConfig(dataDir) });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/push-config ───────────────────────────────────────────────
  // Pousse questions + event_meta de l'événement actif vers le Hub (overwrite).
  // Autorisé en mode preview — usage principal : client ajuste et remonte sa config.
  router.post('/sync/push-config', auth, async (req, res, next) => {
    try {
      if (!config.hubUrl && !cfg.hubUrl) {
        return res.status(409).json({ error: 'Borne en mode autonome — aucun Hub configuré' });
      }
      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });
      const result = await pushConfig(active.id, dataDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/push/:eventId ─────────────────────────────────────────────
  // Lance le push en tâche de fond. 409 si event pas closed, déjà en cours, ou mode démo.
  router.post('/sync/push/:eventId', auth, (req, res, next) => {
    const { eventId } = req.params;
    const db = getRegistry();
    const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);

    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    if (isPreviewMode(cfg)) {
      return res.status(409).json({ error: 'Push interdit en mode démo (borne d\'essai)' });
    }

    if (event.status !== 'closed') {
      return res.status(409).json({ error: 'Clôturez l\'événement avant le push' });
    }

    const state = getPushState();
    if (state.running) {
      return res.status(409).json({ error: 'Un push est déjà en cours' });
    }

    // Lancement en tâche de fond — la progression se lit via GET /sync/status
    pushEvent(eventId, dataDir).catch(() => {});

    res.json({ ok: true });
  });

  // ── POST /api/sync/reset-preview ─────────────────────────────────────────────
  // Purge sessions + vidéos de l'événement actif sans toucher aux questions.
  // Refusé hors mode démo (§11.21 / 6D.3).
  router.post('/sync/reset-preview', auth, (req, res, next) => {
    try {
      if (!isPreviewMode(cfg)) {
        return res.status(403).json({ error: 'Disponible uniquement en mode démo (borne d\'essai)' });
      }

      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });

      const db = getActiveEventDb(dataDir, active);
      const videos = db.prepare('SELECT filename FROM videos').all();

      db.transaction(() => {
        db.prepare('DELETE FROM videos').run();
        db.prepare('DELETE FROM sessions').run();
      })();

      for (const v of videos) {
        unlink(join(dataDir, 'events', active.id, 'videos', v.filename), () => {});
      }

      res.json({ ok: true, deleted: videos.length });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/purge/:eventId ────────────────────────────────────────────
  // Supprime les fichiers locaux après push. Exige status='pushed' et { confirm: name }.
  router.post('/sync/purge/:eventId', auth, (req, res, next) => {
    try {
      const { eventId } = req.params;
      const { confirm } = req.body ?? {};
      const db = getRegistry();
      const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);

      if (!event) return res.status(404).json({ error: 'Événement introuvable' });

      if (event.status !== 'pushed') {
        return res.status(409).json({ error: 'Seul un événement poussé peut être purgé' });
      }

      if (!confirm || confirm !== event.name) {
        return res.status(400).json({ error: 'Confirmation par le nom de l\'événement requise' });
      }

      // §11.11 : fermer le handle SQLite de l'event avant tout rm -rf
      // (l'event purgé peut encore être l'actif si close/push n'ont pas remis active=0)
      closeEventDb();

      // Supprime le dossier physique (vidéos, db.sqlite, etc.)
      const eventDir = join(dataDir, 'events', eventId);
      if (existsSync(eventDir)) {
        rmSync(eventDir, { recursive: true, force: true });
      }

      // Nettoie push_state + désactive l'event (ne doit plus être servi au kiosque)
      db.prepare('DELETE FROM push_state WHERE event_id = ?').run(eventId);
      db.prepare('UPDATE local_events SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventId);

      // Passe en 'purged'
      updateEventStatus(eventId, 'purged');

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
