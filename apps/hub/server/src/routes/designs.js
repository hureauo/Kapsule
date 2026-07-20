import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import multer from 'multer';

import { validateDesign, DESIGN_IMAGE_SCREENS } from '@kapsule/core';
import { requireUser } from '../middleware/auth.js';
import {
  getDb,
  insertDesign, getDesign, listDesigns, updateDesign, deleteDesign,
  insertDesignVersion, listDesignVersions, getDesignVersion,
  defaultDesignConfig, getUserById,
  listEventsByDesignSource, deleteEventDesignRef,
} from '../registry.js';
import { materializeEventDesign } from './events.js';
import { triggerPreviewPull } from './previewGallery.js';

// Images d'un design : raster uniquement, jamais de SVG (invariant §11.28 — un
// SVG peut embarquer <script>/on*). L'extension est dérivée du mimetype, jamais
// du nom envoyé par le client.
const ASSET_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const ASSET_MAX_BYTES = 2 * 1024 * 1024; // 2 Mo

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Répertoire des assets d'un design (design.E les remplira ; ici on gère déjà
// la copie à la duplication et la purge à la suppression).
//
// Défense en profondeur : `id` vient toujours de la base (colonne alimentée par
// randomUUID()), jamais de l'URL — un :id contenant '../' ne matche aucune ligne
// et part en 404 avant d'atteindre le disque. On revérifie quand même la forme
// avant tout rmSync/cpSync : le coût est nul et ça ferme la classe de bug
// (path traversal) même si un futur appelant se trompe de source.
const designDir = (dataDir, id) => {
  if (!UUID_RE.test(id)) throw new Error(`Identifiant de design invalide : ${id}`);
  return join(dataDir, 'designs', id);
};

// Un design est lisible par son propriétaire, par tout le monde si c'est un
// template, et par un superuser. Il n'est modifiable que par son propriétaire
// ou un superuser — et un template n'est modifiable QUE par un superuser.
function canRead(design, user) {
  if (user.role === 'superuser') return true;
  if (design.is_template) return true;
  return design.owner_id === user.sub;
}

function canWrite(design, user) {
  if (user.role === 'superuser') return true;
  if (design.is_template) return false; // template : superuser seul
  return design.owner_id === user.sub;
}

// L'auteur d'une version est l'email d'un COMPTE client. Un design promu en
// template reste lisible par TOUS les clients tout en gardant son owner_id :
// sans ce filtre, l'email du propriétaire d'origine fuiterait à chaque lecteur
// du template. Seuls le propriétaire et les superusers voient l'auteur.
function canSeeAuthor(design, user) {
  return user.role === 'superuser' || design.owner_id === user.sub;
}

const stripAuthor = (version) => ({ ...version, author: null });

// Template livré avec le produit (seed) : pas de propriétaire. Ni supprimable ni
// rétrogradable — le seed ne se rejoue pas (no-op si la table est non vide) et,
// sans propriétaire, un seed rétrogradé deviendrait invisible de tout le monde.
const isSeedTemplate = (design) => design.is_template === 1 && design.owner_id === null;

// Charge le design de :id, ou répond 404. Renvoie null si déjà répondu.
function loadDesign(req, res) {
  const design = getDesign(getDb(), req.params.id);
  if (!design) {
    res.status(404).json({ error: 'Design introuvable' });
    return null;
  }
  return design;
}

// email de l'auteur pour l'historique (même convention que event_versions).
function authorEmail(db, user) {
  return getUserById(db, user.sub)?.email ?? null;
}

/**
 * Borne d'essai vivante (design2, §9bis « Rafraîchissement de la borne d'essai ») :
 * après une édition du design (config ou asset), re-matérialise la copie des
 * événements EN STATUT `preview` qui en sont issus, puis déclenche leur pull.
 * Les événements non-preview ne sont jamais touchés — l'invariant §11.26 tient :
 * ce n'est pas une référence vivante, juste un rafraîchissement explicite et
 * borné aux données jetables de la borne d'essai.
 */
function refreshPreviewEvents(db, dataDir, designId) {
  const design = getDesign(db, designId);
  if (!design) return; // design supprimé entre-temps : rien à rafraîchir
  const refs = listEventsByDesignSource(db, designId);
  for (const ref of refs) {
    if (ref.status !== 'preview') continue;
    const result = materializeEventDesign(dataDir, ref.event_id, design);
    if (!result.ok) continue; // design dégradé (image manquante) : on laisse la copie précédente
    triggerPreviewPull(ref.event_id);
  }
}

// Monté sous /api/designs
export function makeDesignsRouter(dataDir) {
  const router = Router();

  // ── GET /api/designs ──────────────────────────────────────────────────────
  router.get('/', requireUser, (req, res) => {
    const designs = listDesigns(getDb(), {
      userId: req.user.sub,
      isSuperuser: req.user.role === 'superuser',
    });
    res.json(designs.map(withParsedConfig));
  });

  // ── POST /api/designs ─────────────────────────────────────────────────────
  // config absente → config par défaut (Cutealism), lue depuis une constante et
  // non depuis une ligne cherchée par nom (les templates sont renommables).
  router.post('/', requireUser, (req, res, next) => {
    try {
      const db = getDb();
      const { name, config } = req.body ?? {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Le nom est requis.' });
      }

      const cfg = config === undefined ? defaultDesignConfig() : config;

      const check = validateDesign(cfg);
      if (!check.ok) return res.status(400).json({ error: check.error });

      const id = randomUUID();
      const config_json = JSON.stringify(cfg);
      insertDesign(db, { id, owner_id: req.user.sub, name: name.trim(), config_json });
      // Version initiale : l'historique part de l'état de création.
      insertDesignVersion(db, { design_id: id, snapshot: config_json, author: authorEmail(db, req.user) });

      res.status(201).json(withParsedConfig(getDesign(db, id)));
    } catch (err) { next(err); }
  });

  // ── GET /api/designs/:id ──────────────────────────────────────────────────
  router.get('/:id', requireUser, (req, res) => {
    const design = loadDesign(req, res);
    if (!design) return;
    if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });
    res.json(withParsedConfig(design));
  });

  // ── GET /api/designs/:id/usage ────────────────────────────────────────────
  // Événements issus de ce design (§9bis) — alimente l'avertissement d'usage de
  // l'éditeur : « seront mis à jour » (preview) vs « gardent leur version » (autres).
  router.get('/:id/usage', requireUser, (req, res) => {
    const design = loadDesign(req, res);
    if (!design) return;
    if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

    const usage = listEventsByDesignSource(getDb(), design.id)
      .map((r) => ({ event_id: r.event_id, name: r.name, status: r.status }));
    res.json(usage);
  });

  // ── PUT /api/designs/:id ──────────────────────────────────────────────────
  // Chaque sauvegarde insère une version du NOUVEL état (append-only).
  router.put('/:id', requireUser, (req, res, next) => {
    try {
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;
      if (!canWrite(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

      const { name, config } = req.body ?? {};
      const fields = {};

      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
          return res.status(400).json({ error: 'Le nom est requis.' });
        }
        fields.name = name.trim();
      }

      if (config !== undefined) {
        const check = validateDesign(config);
        if (!check.ok) return res.status(400).json({ error: check.error });
        fields.config_json = JSON.stringify(config);
      }

      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'Rien à mettre à jour.' });
      }

      updateDesign(db, design.id, fields);
      const updated = getDesign(db, design.id);
      insertDesignVersion(db, {
        design_id: design.id,
        snapshot: updated.config_json,
        author: authorEmail(db, req.user),
      });

      if (config !== undefined) refreshPreviewEvents(db, dataDir, design.id);

      res.json(withParsedConfig(updated));
    } catch (err) { next(err); }
  });

  // ── DELETE /api/designs/:id ───────────────────────────────────────────────
  // Détache les événements (retrait des event_design_refs) : leur copie figée
  // subsiste, ils ne sont simplement plus rafraîchissables (§9bis).
  router.delete('/:id', requireUser, (req, res, next) => {
    try {
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;
      if (!canWrite(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

      // Un template d'origine ne se supprime pas : le seed est un no-op dès que
      // la table est non vide, donc il ne reviendrait jamais (hors périmètre v1).
      if (isSeedTemplate(design)) {
        return res.status(409).json({ error: 'Un template d\'origine ne peut pas être supprimé.' });
      }

      for (const ref of listEventsByDesignSource(db, design.id)) {
        deleteEventDesignRef(db, ref.event_id);
      }

      deleteDesign(db, design.id); // design_versions suit par ON DELETE CASCADE
      rmSync(designDir(dataDir, design.id), { recursive: true, force: true });

      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── POST /api/designs/:id/duplicate ───────────────────────────────────────
  // Copie config + fichiers assets. Le nouveau design appartient au user courant.
  router.post('/:id/duplicate', requireUser, (req, res, next) => {
    try {
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;
      if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

      const id = randomUUID();
      insertDesign(db, {
        id,
        owner_id: req.user.sub,
        name: `${design.name} (copie)`,
        config_json: design.config_json,
        is_template: 0, // une copie n'hérite jamais du statut de template
      });
      insertDesignVersion(db, {
        design_id: id,
        snapshot: design.config_json,
        author: authorEmail(db, req.user),
      });

      // Les assets sont référencés par nom de fichier dans la config : la copie
      // doit dupliquer les fichiers, sinon le nouveau design pointerait vers le
      // dossier de l'ancien (et sa suppression le casserait).
      const src = designDir(dataDir, design.id);
      if (existsSync(src)) {
        const dest = designDir(dataDir, id);
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true });
      }

      res.status(201).json(withParsedConfig(getDesign(db, id)));
    } catch (err) { next(err); }
  });

  // ── POST /api/designs/:id/promote ─────────────────────────────────────────
  router.post('/:id/promote', requireUser, (req, res, next) => {
    try {
      if (req.user.role !== 'superuser') {
        return res.status(403).json({ error: 'Réservé aux superusers' });
      }
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;

      if (design.is_template) {
        return res.status(409).json({ error: 'Ce design est déjà un template.' });
      }

      updateDesign(db, design.id, { is_template: 1 });
      res.json(withParsedConfig(getDesign(db, design.id)));
    } catch (err) { next(err); }
  });

  // ── POST /api/designs/:id/demote ──────────────────────────────────────────
  // Retire le statut de template (une promotion par erreur rend le design visible
  // de TOUS les clients — il faut pouvoir revenir en arrière).
  router.post('/:id/demote', requireUser, (req, res, next) => {
    try {
      if (req.user.role !== 'superuser') {
        return res.status(403).json({ error: 'Réservé aux superusers' });
      }
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;

      if (!design.is_template) {
        return res.status(409).json({ error: 'Ce design n\'est pas un template.' });
      }
      if (isSeedTemplate(design)) {
        return res.status(409).json({ error: 'Un template d\'origine ne peut pas être rétrogradé.' });
      }

      updateDesign(db, design.id, { is_template: 0 });
      res.json(withParsedConfig(getDesign(db, design.id)));
    } catch (err) { next(err); }
  });

  // ── GET /api/designs/:id/versions ─────────────────────────────────────────
  router.get('/:id/versions', requireUser, (req, res) => {
    const design = loadDesign(req, res);
    if (!design) return;
    if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

    const versions = listDesignVersions(getDb(), design.id);
    res.json(canSeeAuthor(design, req.user) ? versions : versions.map(stripAuthor));
  });

  // ── GET /api/designs/:id/versions/:vid ────────────────────────────────────
  router.get('/:id/versions/:vid', requireUser, (req, res) => {
    const db = getDb();
    const design = loadDesign(req, res);
    if (!design) return;
    if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

    const version = getDesignVersion(db, req.params.vid);
    if (!version || version.design_id !== design.id) {
      return res.status(404).json({ error: 'Version introuvable' });
    }
    const visible = canSeeAuthor(design, req.user) ? version : stripAuthor(version);
    res.json({ ...visible, snapshot: JSON.parse(version.snapshot) });
  });

  // ── POST /api/designs/:id/restore ─────────────────────────────────────────
  // Append-only : l'état courant est re-versionné avant d'être remplacé, donc
  // une restauration ne perd jamais la configuration qu'elle écrase.
  router.post('/:id/restore', requireUser, (req, res, next) => {
    try {
      const db = getDb();
      const design = loadDesign(req, res);
      if (!design) return;
      if (!canWrite(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

      // Doit être un entier : better-sqlite3 lève (→ 500) si on lui binde un
      // objet ou un tableau. On rejette en 400 avant d'atteindre la requête.
      // Le test de type précède la coercition (Number([]) === 0 passerait).
      const raw = req.body?.version_id;
      const version_id = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(version_id)) {
        return res.status(400).json({ error: 'version_id doit être un entier.' });
      }

      const version = getDesignVersion(db, version_id);
      if (!version || version.design_id !== design.id) {
        return res.status(404).json({ error: 'Version introuvable' });
      }

      // Revalidation défensive : le snapshot était valide au moment de son
      // insertion, mais les règles peuvent s'être durcies depuis. Restaurer ne
      // doit jamais réintroduire une config que le contrat courant refuse.
      let snapshot;
      try {
        snapshot = JSON.parse(version.snapshot);
      } catch {
        return res.status(409).json({ error: 'Cette version est illisible.' });
      }
      const check = validateDesign(snapshot);
      if (!check.ok) {
        return res.status(409).json({ error: `Cette version n'est plus valide : ${check.error}` });
      }

      const author = authorEmail(db, req.user);
      // 1. re-version l'état courant (il ne doit pas disparaître)
      insertDesignVersion(db, { design_id: design.id, snapshot: design.config_json, author });
      // 2. applique le snapshot
      updateDesign(db, design.id, { config_json: version.snapshot });
      // 3. version l'état restauré (l'historique reflète l'état réel après action)
      insertDesignVersion(db, { design_id: design.id, snapshot: version.snapshot, author });

      res.json(withParsedConfig(getDesign(db, design.id)));
    } catch (err) { next(err); }
  });

  // ── Assets (images du design) ─────────────────────────────────────────────

  // Le fichier est écrit sous un nom que NOUS générons (uuid + extension dérivée
  // du mimetype) : le nom d'origine du client n'atteint jamais le disque.
  const uploadAsset = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try {
          const dir = designDir(dataDir, req.design.id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        } catch (err) { cb(err); }
      },
      filename(req, file, cb) {
        cb(null, `${randomUUID()}${ASSET_MIME_EXT[file.mimetype]}`);
      },
    }),
    limits: { fileSize: ASSET_MAX_BYTES, files: 1 },
    fileFilter(req, file, cb) {
      // Whitelist de mimetypes. Contrairement aux vidéos (§11.4, Safari envoie
      // parfois un mime générique), ici la source est un <input type="file"> de
      // l'éditeur Hub sur desktop : on peut être strict.
      if (!ASSET_MIME_EXT[file.mimetype]) {
        return cb(Object.assign(new Error('Format accepté : PNG, JPEG ou WebP.'), { status: 400 }));
      }
      cb(null, true);
    },
  });

  // Résout le design et vérifie le droit d'écriture AVANT multer : sans ça, un
  // upload non autorisé serait écrit sur disque puis rejeté.
  function loadWritableDesign(req, res, next) {
    const design = loadDesign(req, res);
    if (!design) return;
    if (!canWrite(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });
    req.design = design;
    next();
  }

  // ── POST /api/designs/:id/assets?screen=start|thanks ──────────────────────
  // Une seule image par écran (design4) : l'upload change le fichier ET fixe le
  // mode. Si le design n'a pas déjà un mode ≠ 'none' pour cet écran, on choisit
  // 'centered' par défaut (le client peut ensuite basculer sur 'cover' via PUT).
  router.post('/:id/assets', requireUser, loadWritableDesign, uploadAsset.single('file'), (req, res, next) => {
    try {
      const db = getDb();
      const { screen } = req.query;
      const design = req.design;

      const cleanup = () => { if (req.file) rmSync(req.file.path, { force: true }); };

      if (!DESIGN_IMAGE_SCREENS.includes(screen)) {
        cleanup(); // le fichier est déjà écrit : ne pas le laisser orphelin
        return res.status(400).json({ error: `screen doit valoir ${DESIGN_IMAGE_SCREENS.join(' ou ')}.` });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier reçu (champ « file »).' });
      }

      const config = JSON.parse(design.config_json);
      const previousEntry = config.images?.[screen] ?? null;
      const previousFilename = previousEntry?.filename ?? null;
      const mode = previousEntry && previousEntry.mode !== 'none' ? previousEntry.mode : 'centered';
      const next_ = {
        ...config,
        images: { ...config.images, [screen]: { mode, filename: req.file.filename } },
      };

      const check = validateDesign(next_);
      if (!check.ok) {
        cleanup();
        return res.status(400).json({ error: check.error });
      }

      const config_json = JSON.stringify(next_);
      updateDesign(db, design.id, { config_json });
      insertDesignVersion(db, { design_id: design.id, snapshot: config_json, author: authorEmail(db, req.user) });

      // L'ancien fichier de cet écran n'est plus référencé : on le supprime
      // APRÈS l'écriture en base (même logique que le remplacement de vidéo, §11.9).
      if (previousFilename && previousFilename !== req.file.filename) {
        rmSync(join(designDir(dataDir, design.id), previousFilename), { force: true });
      }

      refreshPreviewEvents(db, dataDir, design.id);

      res.status(201).json({ filename: req.file.filename, mode });
    } catch (err) {
      if (req.file) rmSync(req.file.path, { force: true });
      next(err);
    }
  });

  // ── DELETE /api/designs/:id/assets/:screen ────────────────────────────────
  // Retire l'image ET remet le mode à 'none' (cohérence mode/filename imposée
  // par validateDesign — on ne peut pas laisser un mode 'cover' sans fichier).
  router.delete('/:id/assets/:screen', requireUser, loadWritableDesign, (req, res, next) => {
    try {
      const db = getDb();
      const { screen } = req.params;
      const design = req.design;

      if (!DESIGN_IMAGE_SCREENS.includes(screen)) {
        return res.status(400).json({ error: `screen doit valoir ${DESIGN_IMAGE_SCREENS.join(' ou ')}.` });
      }

      const config = JSON.parse(design.config_json);
      const filename = config.images?.[screen]?.filename ?? null;
      if (!filename) return res.status(404).json({ error: 'Aucune image sur cet écran.' });

      const config_json = JSON.stringify({
        ...config,
        images: { ...config.images, [screen]: { mode: 'none', filename: null } },
      });
      updateDesign(db, design.id, { config_json });
      insertDesignVersion(db, { design_id: design.id, snapshot: config_json, author: authorEmail(db, req.user) });

      rmSync(join(designDir(dataDir, design.id), filename), { force: true });

      refreshPreviewEvents(db, dataDir, design.id);

      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── GET /api/designs/:id/assets/:filename ─────────────────────────────────
  // Anti path-traversal : le filename doit figurer dans la config du design.
  // On ne fait donc jamais confiance au paramètre d'URL pour construire le chemin.
  router.get('/:id/assets/:filename', requireUser, (req, res, next) => {
    try {
      const design = loadDesign(req, res);
      if (!design) return;
      if (!canRead(design, req.user)) return res.status(403).json({ error: 'Accès interdit' });

      const config = JSON.parse(design.config_json);
      const known = DESIGN_IMAGE_SCREENS
        .map((screen) => config.images?.[screen]?.filename)
        .filter(Boolean);

      if (!known.includes(req.params.filename)) {
        return res.status(404).json({ error: 'Image introuvable' });
      }

      res.sendFile(join(designDir(dataDir, design.id), req.params.filename));
    } catch (err) { next(err); }
  });

  return router;
}

// La config est stockée sérialisée ; l'API expose l'objet.
function withParsedConfig(design) {
  return { ...design, config: JSON.parse(design.config_json) };
}
