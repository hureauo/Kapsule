import { Router } from 'express';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getRegistry, updateEventStatus } from '../registry.js';
import { closeEventDb } from '../eventDb.js';
import { getLastPull } from '../sync/autoPull.js';
import { pushEvent, getPushState } from '../sync/push.js';
import { pullAssigned } from '../sync/pull.js';

export function makeSyncRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;

  // ── GET /api/sync/status ─────────────────────────────────────────────────────
  // Retourne : { online, hubUrl, lastPull, push: { running, total, done, currentFile } }
  router.get('/sync/status', auth, (req, res) => {
    const online = !!(cfg.hubUrl || config.hubUrl);
    const hubUrl = cfg.hubUrl || config.hubUrl || null;
    res.json({
      online,
      hubUrl,
      lastPull: getLastPull(),
      push: getPushState(),
    });
  });

  // ── POST /api/sync/pull ──────────────────────────────────────────────────────
  // Pull manuel immédiat (best-effort, sans attendre la fin)
  router.post('/sync/pull', auth, (req, res) => {
    pullAssigned(dataDir).catch(() => {}); // silencieux
    res.json({ ok: true });
  });

  // ── POST /api/sync/push/:eventId ─────────────────────────────────────────────
  // Lance le push en tâche de fond. 409 si event pas closed ou push déjà en cours.
  router.post('/sync/push/:eventId', auth, (req, res, next) => {
    const { eventId } = req.params;
    const db = getRegistry();
    const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);

    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

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
