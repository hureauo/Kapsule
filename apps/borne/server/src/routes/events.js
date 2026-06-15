import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { DEFAULTS, LIMITS, THEMES } from '@kapsule/core';
import {
  getActiveEvent, listEvents, insertEvent, setActiveEvent, updateEventStatus,
} from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';
import { getPushState } from '../sync/push.js';

export function makeEventsRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;

  // ── Routes admin ─────────────────────────────────────────────────────────

  router.get('/events', auth, (req, res) => {
    res.json(listEvents());
  });

  router.post('/events', auth, (req, res, next) => {
    try {
      const { name, event_date } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Le nom de l\'événement est requis' });
      }
      const id = uuidv4();
      const eventDir = join(dataDir, 'events', id);
      mkdirSync(join(eventDir, 'videos'), { recursive: true });

      const db = createEventDb(join(eventDir, 'db.sqlite'));
      db.prepare(`INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)`).run('event_id', id);
      db.prepare(`INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)`).run('name', name.trim());
      db.prepare(`INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)`).run('origin', 'local');
      db.prepare(`INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)`).run('theme', DEFAULTS.THEME);
      if (event_date) {
        db.prepare(`INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)`).run('event_date', event_date);
      }
      db.close();

      insertEvent({ id, name: name.trim(), origin: 'local' });
      const event = listEvents().find(e => e.id === id);
      res.status(201).json(event);
    } catch (err) {
      next(err);
    }
  });

  router.put('/events/:id/activate', auth, (req, res, next) => {
    try {
      const { id } = req.params;
      const all = listEvents();
      const event = all.find(e => e.id === id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (event.status === 'pushed' || event.status === 'purged') {
        return res.status(409).json({ error: 'Impossible d\'activer un événement déjà poussé ou purgé' });
      }
      // §6 : activation refusée pendant un push en cours (changer d'événement actif
      // pendant que push.js lit la BD/les fichiers d'un autre event = état incohérent)
      if (getPushState().running) {
        return res.status(409).json({ error: 'Un push est en cours — réessayez après' });
      }
      setActiveEvent(id);
      res.json(listEvents().find(e => e.id === id));
    } catch (err) {
      next(err);
    }
  });

  router.put('/events/:id/close', auth, (req, res, next) => {
    try {
      const { id } = req.params;
      const all = listEvents();
      const event = all.find(e => e.id === id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (event.status !== 'live') {
        return res.status(409).json({ error: 'Seul un événement en cours (live) peut être clôturé' });
      }
      updateEventStatus(id, 'closed');
      res.json(listEvents().find(e => e.id === id));
    } catch (err) {
      next(err);
    }
  });

  // Réglages d'événement (config, pas donnée invité → conforme RGPD §11).
  // Pour l'instant : le thème visuel du parcours invité. Écrit dans event_meta
  // de events/<id>/db.sqlite. Validé contre la liste blanche THEMES.
  router.put('/events/:id/settings', auth, (req, res, next) => {
    try {
      const { id } = req.params;
      const { theme } = req.body;
      const event = listEvents().find(e => e.id === id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });

      if (theme !== undefined && !THEMES.includes(theme)) {
        return res.status(400).json({ error: `Thème invalide (attendu : ${THEMES.join(', ')})` });
      }

      // Le thème ne concerne que l'événement vu par les invités (l'actif).
      // Restreindre à l'actif évite aussi que getActiveEventDb (cache à un slot)
      // ne ferme le handle de l'actif en ouvrant celui d'un autre événement.
      const activeEvent = getActiveEvent();
      if (!activeEvent || activeEvent.id !== id) {
        return res.status(409).json({ error: 'Seul l\'événement actif peut être configuré' });
      }

      const db = getActiveEventDb(dataDir, activeEvent);
      if (theme !== undefined) {
        db.prepare(`INSERT INTO event_meta (key, value) VALUES ('theme', ?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(theme);
      }
      const getMeta = (key) => db.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value ?? null;
      res.json({ id, theme: getMeta('theme') ?? DEFAULTS.THEME });
    } catch (err) {
      next(err);
    }
  });

  router.get('/preflight', auth, async (req, res, next) => {
    try {
      const activeEvent = getActiveEvent();
      const stats = await statfs(dataDir);
      const free_bytes = stats.bfree * stats.bsize;
      const disk_ok = free_bytes > LIMITS.DISK_ALERT_BYTES;

      let event_info = { loaded: false, pulled_at: null };
      let questions_count = 0;

      if (activeEvent) {
        event_info = { loaded: true, pulled_at: activeEvent.pulled_at ?? null };
        const db = getActiveEventDb(dataDir, activeEvent);
        questions_count = db.prepare('SELECT COUNT(*) as n FROM questions WHERE enabled=1').get().n;
      }

      let clock_ok = null;
      const client_time = req.query.client_time;
      if (client_time) {
        const clientMs = new Date(client_time).getTime();
        if (!isNaN(clientMs)) {
          clock_ok = Math.abs(Date.now() - clientMs) < 2 * 60 * 1000;
        }
      }

      res.json({ event: event_info, questions_count, disk_ok, clock_ok });
    } catch (err) {
      next(err);
    }
  });

  // ── Route publique (kiosque) ──────────────────────────────────────────────

  router.get('/event', (req, res, next) => {
    try {
      const activeEvent = getActiveEvent();
      if (!activeEvent) return res.status(404).json({ error: 'Aucun événement actif' });

      const db = getActiveEventDb(dataDir, activeEvent);
      const getMeta = (key) => db.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value ?? null;

      res.json({
        id: activeEvent.id,
        name: activeEvent.name,
        status: activeEvent.status,
        consent_text: getMeta('consent_text') ?? DEFAULTS.CONSENT_TEXT,
        idle_timeout: parseInt(getMeta('idle_timeout') ?? String(DEFAULTS.IDLE_TIMEOUT_S), 10),
        theme: getMeta('theme') ?? DEFAULTS.THEME,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
