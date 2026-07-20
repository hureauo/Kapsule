import { Router } from 'express';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import rateLimit from 'express-rate-limit';
import {
  DEFAULTS, LIMITS, THEMES, TEXT_FIELDS, TEXT_FIELD_MAX,
  QUALITY_KEYS, VIDEO_ORIENTATIONS, DEFAULT_VIDEO_QUALITY, DEFAULT_VIDEO_ORIENTATION, resolvePreset,
  DESIGN_IMAGE_SCREENS, validateDesign, isValidAssetFilename,
} from '@kapsule/core';
import {
  getActiveEvent, listEvents, setActiveEvent, updateEventStatus,
} from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';
import { getPushState } from '../sync/push.js';

/**
 * Résout les réglages vidéo effectifs d'un événement, sur une event DB ouverte.
 *
 * Cascade : override local (local_overrides) > défaut Hub (event_meta) > défaut core.
 * local_overrides n'est jamais écrasé par le pull (contrairement à event_meta) :
 * un réglage fait sur place tient face au Hub.
 *
 * Les clés retournées sont NORMALISÉES : une valeur corrompue en base (push/import
 * direct contournant la validation des routes) retombe sur le défaut plutôt que de
 * ressortir telle quelle — les fronts s'en servent pour présélectionner leurs <select>.
 *
 * Source unique de la résolution : GET /api/event et PUT /api/event/video-quality
 * l'utilisent tous les deux, sans quoi ils pourraient répondre des valeurs différentes.
 */
function resolveVideoSettings(db) {
  const read = (key) =>
    db.prepare('SELECT value FROM local_overrides WHERE key=?').get(key)?.value
    ?? db.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value
    ?? null;

  const rawQuality = read('video_quality');
  const rawOrientation = read('video_orientation');

  const quality = QUALITY_KEYS.includes(rawQuality) ? rawQuality : DEFAULT_VIDEO_QUALITY;
  const orientation = VIDEO_ORIENTATIONS.includes(rawOrientation) ? rawOrientation : DEFAULT_VIDEO_ORIENTATION;

  return { quality, orientation, preset: resolvePreset(quality, orientation) };
}

/**
 * Parse le design stocké dans event_meta et le prépare pour le kiosque (§9bis).
 *
 * Retourne null si aucun design, si le JSON est corrompu, ou si le contenu ne
 * respecte plus le contrat : dans tous ces cas le kiosque doit se comporter
 * exactement comme avant (thèmes figés), jamais planter.
 *
 * Une seule image par écran (design4) : { mode, filename } où filename devient
 * une URL servie par GET /api/event/design/:filename (le front consomme
 * directement image.filename comme src/backgroundImage, jamais le nom brut).
 */
function resolveDesign(raw) {
  if (!raw) return null;

  let design;
  try {
    design = JSON.parse(raw);
  } catch {
    return null;
  }

  const check = validateDesign(design);
  if (!check.ok) return null;

  const images = {};
  for (const screen of DESIGN_IMAGE_SCREENS) {
    const entry = design.images?.[screen] ?? { mode: 'none', filename: null };
    images[screen] = {
      mode: entry.mode,
      filename: entry.filename ? `/api/event/design/${entry.filename}` : null,
    };
  }

  return {
    colors: design.colors ?? {},
    radius: design.radius ?? null,
    font: design.font ?? null,
    images,
    // Corrige un bug préexistant (design3) : screenOverrides n'était jamais
    // transmis au kiosque — resolveScreenColors (core) ne pouvait donc jamais
    // trouver de surcharge côté borne réelle, alors que l'éditeur Hub et les
    // tests fonctionnaient (ils passent l'objet design complet directement).
    screenOverrides: design.screenOverrides ?? {},
  };
}

export function makeEventsRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;
  const authTech = cfg.requireTech;

  // Rate-limiter pour la route d'écriture publique (borne preview Internet-facing).
  // Instancié par app pour éviter la pollution entre suites de tests.
  const videoQualityLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes, réessayez dans un moment.' },
    skip: () => cfg.skipRateLimits === true,
  });

  // ── Routes admin ─────────────────────────────────────────────────────────

  router.get('/events', auth, (req, res) => {
    res.json(listEvents());
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

      // requiresLogin est stocké dans event_meta au pull (§11.24).
      // Les users 'general' ne sont plus dans event_users — auth proxiée vers Hub.
      const requiresLoginMeta = db.prepare("SELECT value FROM event_meta WHERE key = 'requires_login'").get();
      const requiresLogin = !!(activeEvent.is_preview) && requiresLoginMeta?.value === 'true';

      const video = resolveVideoSettings(db);

      res.json({
        id: activeEvent.id,
        name: activeEvent.name,
        status: activeEvent.status,
        consent_text: consent,
        idle_timeout: parseInt(getMeta('idle_timeout') ?? String(DEFAULTS.IDLE_TIMEOUT_S), 10),
        theme: getMeta('theme') ?? DEFAULTS.THEME,
        // null si aucun design appliqué OU si la meta est corrompue : le kiosque
        // retombe alors sur les thèmes figés, sans planter (§9bis).
        design: resolveDesign(getMeta('design')),
        welcome_title: getMeta('welcome_title') || activeEvent.name,
        welcome_subtitle: getMeta('welcome_subtitle') || consent.split('\n')[0],
        name_prompt: textOrDefault('name_prompt'),
        consent_details: textOrDefault('consent_details'),
        thanks_text: textOrDefault('thanks_text'),
        requiresLogin,
        is_preview: !!(activeEvent.is_preview),
        video_quality: video.quality,
        video_orientation: video.orientation,
        video_width: video.preset.width,
        video_height: video.preset.height,
        video_bitrate: video.preset.videoBitrate,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/event/design/:filename ──────────────────────────────────────
  // Sert une image du design appliqué. Public, comme GET /api/event (le kiosque
  // n'est pas authentifié sur la borne physique).
  //
  // Anti path-traversal : le filename doit figurer dans event_meta.design. On ne
  // construit jamais un chemin depuis l'URL sans l'avoir confronté à la config.
  router.get('/event/design/:filename', (req, res, next) => {
    try {
      const activeEvent = getActiveEvent();
      if (!activeEvent) return res.status(404).json({ error: 'Aucun événement actif' });

      const db = getActiveEventDb(dataDir, activeEvent);
      const raw = db.prepare("SELECT value FROM event_meta WHERE key='design'").get()?.value;

      // Passe par resolveDesign : un design corrompu ou invalide au regard du
      // contrat ne doit pas servir de whitelist. Sans cette revalidation, une meta
      // corrompue transformerait ce sendFile en lecture de fichier arbitraire.
      const design = resolveDesign(raw);
      if (!design) return res.status(404).json({ error: 'Aucun design' });

      // resolveDesign a transformé les noms en URLs : on remonte au nom de fichier.
      const known = DESIGN_IMAGE_SCREENS
        .map((screen) => design.images?.[screen]?.filename)
        .filter(Boolean)
        .map((url) => url.slice(url.lastIndexOf('/') + 1));

      // Double garde : le filename est déjà contraint par validateDesign (uuid +
      // extension raster), on le revérifie avant de construire le chemin.
      if (!known.includes(req.params.filename) || !isValidAssetFilename(req.params.filename)) {
        return res.status(404).json({ error: 'Image introuvable' });
      }

      res.sendFile(join(dataDir, 'events', activeEvent.id, 'design', req.params.filename));
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/event/video-quality ─────────────────────────────────────────
  // Override local persistant de la qualité ET de l'orientation vidéo (survit au
  // pull Hub). Les deux champs du body sont optionnels et indépendants : on peut
  // changer l'orientation sans toucher la qualité, et inversement.
  // En preview : accessible sans auth (borne en mode démo, invité ou tech).
  // Hors preview : requiert tech_borne (même garde que les routes tech).
  // Préfixe /event/ et non /admin/ car la route est publique en preview ;
  // /admin/ désigne partout ailleurs une route protégée par requireAdmin/requireTech.
  router.put('/event/video-quality', videoQualityLimiter, (req, res, next) => {
    const activeEvent = getActiveEvent();
    if (!activeEvent) return res.status(404).json({ error: 'Aucun événement actif' });
    if (activeEvent.is_preview) return handler(req, res, next, activeEvent);
    // Borne réelle → guard tech_borne, puis handler
    authTech(req, res, () => handler(req, res, next, activeEvent));
  });

  function handler(req, res, next, activeEvent) {
    try {
      const { quality, orientation } = req.body ?? {};
      if (quality === undefined && orientation === undefined) {
        return res.status(400).json({ error: 'Body vide : fournir quality et/ou orientation.' });
      }
      if (quality !== undefined && !QUALITY_KEYS.includes(quality)) {
        return res.status(400).json({ error: `Qualité invalide. Valeurs : ${QUALITY_KEYS.join(', ')}` });
      }
      if (orientation !== undefined && !VIDEO_ORIENTATIONS.includes(orientation)) {
        return res.status(400).json({ error: `Orientation invalide. Valeurs : ${VIDEO_ORIENTATIONS.join(', ')}` });
      }

      const db = getActiveEventDb(dataDir, activeEvent);
      const upsert = db.prepare('INSERT OR REPLACE INTO local_overrides (key, value) VALUES (?, ?)');
      if (quality !== undefined) upsert.run('video_quality', quality);
      if (orientation !== undefined) upsert.run('video_orientation', orientation);

      // On relit la cascade complète (même résolution que GET /api/event) : le champ
      // non fourni garde sa valeur effective, et le PUT ne peut pas répondre autre
      // chose que ce que le GET suivant renverra.
      const video = resolveVideoSettings(db);
      res.json({
        ok: true,
        video_quality: video.quality,
        video_orientation: video.orientation,
        ...video.preset,
      });
    } catch (err) {
      next(err);
    }
  }

  return router;
}
