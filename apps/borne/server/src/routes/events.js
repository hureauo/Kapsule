import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { DEFAULTS, LIMITS, THEMES, TEXT_FIELDS, TEXT_FIELD_MAX } from '@kapsule/core';
import {
  getActiveEvent, listEvents, insertEvent, setActiveEvent, updateEventStatus,
} from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';
import { getPushState } from '../sync/push.js';

export function makeEventsRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;
  const authTech = cfg.requireTech;

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

  router.put('/events/:id/close', authTech, (req, res, next) => {
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
  // Thème visuel + textes éditables du parcours invité. Écrit dans event_meta
  // de events/<id>/db.sqlite. Voir design/parcours-invite.md §11.
  router.put('/events/:id/settings', auth, (req, res, next) => {
    try {
      const { id } = req.params;
      const { theme } = req.body;
      const event = listEvents().find(e => e.id === id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });

      if (theme !== undefined && !THEMES.includes(theme)) {
        return res.status(400).json({ error: `Thème invalide (attendu : ${THEMES.join(', ')})` });
      }

      // Valider les champs texte présents dans le body.
      const textUpdates = {};
      for (const key of Object.keys(TEXT_FIELDS)) {
        const val = req.body[key];
        if (val === undefined) continue;
        if (typeof val !== 'string') {
          return res.status(400).json({ error: `Champ "${key}" doit être une chaîne` });
        }
        if (val.length > TEXT_FIELD_MAX) {
          return res.status(400).json({ error: `Champ "${key}" dépasse ${TEXT_FIELD_MAX} caractères` });
        }
        textUpdates[key] = val.trim();
      }

      // Le thème et les textes ne concernent que l'événement vu par les invités (l'actif).
      // Restreindre à l'actif évite aussi que getActiveEventDb (cache à un slot)
      // ne ferme le handle de l'actif en ouvrant celui d'un autre événement.
      const activeEvent = getActiveEvent();
      if (!activeEvent || activeEvent.id !== id) {
        return res.status(409).json({ error: 'Seul l\'événement actif peut être configuré' });
      }

      const db = getActiveEventDb(dataDir, activeEvent);
      const upsertMeta = db.prepare(
        `INSERT INTO event_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      );
      if (theme !== undefined) upsertMeta.run('theme', theme);
      for (const [key, val] of Object.entries(textUpdates)) upsertMeta.run(key, val);

      const getMeta = (key) => db.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value ?? null;
      const consent = getMeta('consent_text') ?? DEFAULTS.CONSENT_TEXT;
      res.json({
        id,
        theme: getMeta('theme') ?? DEFAULTS.THEME,
        welcome_title:    getMeta('welcome_title')    || activeEvent.name,
        welcome_subtitle: getMeta('welcome_subtitle') || consent.split('\n')[0],
        name_prompt:      getMeta('name_prompt')      ?? DEFAULTS.NAME_PROMPT,
        consent_text:     consent,
        consent_details:  getMeta('consent_details')  ?? DEFAULTS.CONSENT_DETAILS,
        thanks_text:      getMeta('thanks_text')      ?? DEFAULTS.THANKS_TEXT,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/preflight', authTech, async (req, res, next) => {
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

      // Textes du parcours : valeur stockée si présente, sinon défaut.
      // welcome_title / welcome_subtitle ont un défaut DYNAMIQUE (vide dans DEFAULTS) :
      // titre ← nom de l'événement, sous-titre ← 1ʳᵉ ligne du consentement.
      const consent = getMeta('consent_text') ?? DEFAULTS.CONSENT_TEXT;
      const textOrDefault = (key) => getMeta(key) ?? TEXT_FIELDS[key];

      res.json({
        id: activeEvent.id,
        name: activeEvent.name,
        status: activeEvent.status,
        consent_text: consent,
        idle_timeout: parseInt(getMeta('idle_timeout') ?? String(DEFAULTS.IDLE_TIMEOUT_S), 10),
        theme: getMeta('theme') ?? DEFAULTS.THEME,
        welcome_title: getMeta('welcome_title') || activeEvent.name,
        welcome_subtitle: getMeta('welcome_subtitle') || consent.split('\n')[0],
        name_prompt: textOrDefault('name_prompt'),
        consent_details: textOrDefault('consent_details'),
        thanks_text: textOrDefault('thanks_text'),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
