import { Router } from 'express';
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import { sha256File } from '@kapsule/core/src/checksum.js';
import { LIMITS, isValidAssetFilename } from '@kapsule/core';
import { getDb, getEvent, updateEvent, insertSyncLog, getUserByEmail } from '../registry.js';
import { openEventDb, closeEventDb } from '../eventStore.js';
import { applyEventConfig } from '../eventConfig.js';
import { requireBox } from '../middleware/boxAuth.js';
import { validateUuidParams } from '../middleware/validateParams.js';

// Format : [hub/sync] ← METHOD /path  token=abc…  detail  → status résultat
function syncLog(req, status, detail = '') {
  const token = (req.headers['x-box-token'] ?? '').slice(0, 8) || '?';
  const event = req.box?.event_id?.slice(0, 8) ?? '?';
  const ok = status < 400;
  const icon = ok ? '✓' : '✗';
  const parts = [`[hub/sync] ${icon} ${req.method} ${req.path}`, `token=${token}…`, `event=${event}…`, `→ ${status}`];
  if (detail) parts.push(detail);
  console.log(parts.join('  '));
}

// Ordre des statuts pour les transitions avant uniquement (heartbeat)
const STATUS_ORDER = ['preview', 'ready', 'loaded', 'live', 'closed', 'pushed', 'processed', 'waiting'];

function statusRank(s) {
  const i = STATUS_ORDER.indexOf(s);
  return i === -1 ? -1 : i;
}

function evDir(dataDir, eventId) {
  return join(dataDir, 'events', eventId);
}

function manifestPath(dataDir, eventId) {
  return join(evDir(dataDir, eventId), 'push_manifest.json');
}

// Vérifie qu'un fichier vidéo pour ce video_id existe déjà avec le bon checksum.
// Retourne true si présent et correct (pas manquant).
async function videoAlreadyReceived(videosDir, videoId, expectedChecksum) {
  if (!existsSync(videosDir)) return false;
  const entries = readdirSync(videosDir);
  const match = entries.find(e => e.startsWith(videoId + '.') || e === videoId);
  if (!match) return false;
  const actual = await sha256File(join(videosDir, match));
  return actual === expectedChecksum;
}

export function makeSyncRouter(dataDir, opts = {}) {
  // maxUploadBytes surchargeable pour les tests (défaut = plafond de production)
  const maxUploadBytes = opts.maxUploadBytes ?? LIMITS.VIDEO_MAX_BYTES;
  const router = Router();
  router.use(requireBox);

  // multer pour les fichiers vidéo (un fichier par requête PUT /files/:videoId)
  // limits (§S3/M2) : borne le débit d'une borne malveillante pour éviter de saturer le
  // disque du VPS (données mutualisées). Même plafond que l'upload Borne (LIMITS.VIDEO_MAX_BYTES).
  const uploadVideo = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = join(evDir(dataDir, req.params.id), 'videos');
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        const ext = extname(file.originalname).toLowerCase() || '.mp4';
        cb(null, `${req.params.videoId}${ext}`);
      },
    }),
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  // multer pour le db.sqlite (reçu en tant que fichier temporaire)
  const uploadDbFile = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        cb(null, evDir(dataDir, req.params.id));
      },
      filename(req, file, cb) {
        cb(null, 'db.sqlite.incoming');
      },
    }),
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  // ── POST /api/sync/events/:id/config — push config depuis borne/preview ──
  // body: { mode: 'overwrite'|'merge', questions: [...], meta: { theme, ... } }
  // Protégé par requireBox (token borne) — pas requireUser (JWT admin).
  router.post('/events/:id/config', validateUuidParams('id'), (req, res, next) => {
    try {
      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) { syncLog(req, 404); return res.status(404).json({ error: 'Événement introuvable' }); }
      if (req.params.id !== req.box.event_id) { syncLog(req, 403); return res.status(403).json({ error: 'Non assigné à cette borne' }); }

      const CONTENT_FROZEN = new Set(['ready', 'live', 'closed', 'pushed', 'processed', 'waiting']);
      if (CONTENT_FROZEN.has(event.status)) {
        syncLog(req, 409, `statut ${event.status}`);
        return res.status(409).json({ error: `Import impossible : événement en statut ${event.status}` });
      }

      const { mode, questions, meta } = req.body;
      if (!['overwrite', 'merge'].includes(mode)) {
        return res.status(400).json({ error: 'mode doit être overwrite ou merge' });
      }

      const edb = openEventDb(event.id, dataDir);
      applyEventConfig(edb, { mode, meta, questions });

      insertSyncLog(db, { event_id: event.id, action: 'config_import', detail: { mode, questions: questions?.length ?? 0 } });
      syncLog(req, 200, `mode=${mode}  questions=${questions?.length ?? 0}`);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── POST /api/sync/event/login ───────────────────────────────────────────
  // Auth wall preview (§11.24, option B) : authentifie email/mdp côté Hub ET
  // vérifie que l'utilisateur est assigné à l'événement du token avec le rôle 'general'.
  // La borne n'a ainsi jamais à stocker ni divulguer la liste des emails assignés.
  // Déclarée avant GET /event pour éviter tout conflit de routing.
  router.post('/event/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, skip: () => opts.skipRateLimits === true }), async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      syncLog(req, 400, 'email ou password manquant');
      return res.status(400).json({ error: 'email et password requis' });
    }

    const db = getDb();
    const event = getEvent(db, req.box.event_id);
    if (!event || event.status !== 'preview') {
      syncLog(req, 403, `statut ${event?.status ?? 'introuvable'} — preview requis`);
      return res.status(403).json({ error: 'Cet événement n\'est pas en cours de preview' });
    }

    // Vérifier les credentials Hub
    const user = getUserByEmail(db, email);
    if (!user || !user.active || !user.password_hash) {
      syncLog(req, 401, `email=${email} inconnu ou inactif`);
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    let valid;
    try {
      valid = await argon2.verify(user.password_hash, password);
    } catch {
      valid = false;
    }
    if (!valid) {
      syncLog(req, 401, `email=${email} mdp incorrect`);
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Vérifier l'assignation à cet événement avec le rôle 'general'
    const assignment = db.prepare(`
      SELECT eu.roles FROM event_users eu
      WHERE eu.event_id = ? AND eu.user_id = ?
    `).get(event.id, user.id);
    const roles = assignment ? JSON.parse(assignment.roles) : [];
    if (!roles.includes('general')) {
      syncLog(req, 403, `email=${email} non assigné general`);
      return res.status(403).json({ error: 'Utilisateur non autorisé pour cet événement' });
    }

    syncLog(req, 200, `email=${email} login preview OK`);
    res.json({ ok: true });
  });

  // ── GET /api/sync/event ───────────────────────────────────────────────────
  // Remplace GET /assigned (liste) — un token = un événement (§11.20)
  router.get('/event', (req, res) => {
    const db = getDb();
    const event = getEvent(db, req.box.event_id);
    if (!event) {
      syncLog(req, 404, 'événement introuvable');
      return res.status(404).json({ error: 'Aucun événement pullable pour ce token' });
    }

    // §11.25 : token preview → statut preview requis ; token réel → ready ou loaded
    if (req.box.is_preview) {
      if (event.status !== 'preview') {
        syncLog(req, 403, `token preview mais statut=${event.status}`);
        return res.status(403).json({ error: `Token d'essai uniquement utilisable en statut preview (statut actuel : ${event.status})` });
      }
    } else {
      if (!['ready', 'loaded'].includes(event.status)) {
        syncLog(req, 404, `statut non pullable: ${event.status}`);
        return res.status(404).json({ error: 'Aucun événement pullable pour ce token' });
      }
    }

    syncLog(req, 200, `name="${event.name}"  status=${event.status}`);
    res.json({
      id: event.id, name: event.name, event_date: event.event_date,
      status: event.status, updated_at: event.updated_at,
      is_preview: req.box.is_preview,
    });
  });

  // ── GET /api/sync/events/:id/bundle ──────────────────────────────────────
  router.get('/events/:id/bundle', validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      // Invariant §11.20 : un token ne peut tirer que son propre événement
      if (req.params.id !== req.box.event_id) return res.status(403).json({ error: 'Token non autorisé sur cet événement' });
      const pullableStatuses = req.box.is_preview ? ['preview'] : ['ready', 'loaded'];
      if (!pullableStatuses.includes(event.status)) {
        return res.status(409).json({ error: `Statut ${event.status} — bundle non disponible` });
      }

      // Token réel : ready→loaded. Token preview : statut inchangé (données jetables).
      if (!req.box.is_preview && event.status === 'ready') {
        updateEvent(db, event.id, { status: 'loaded', pulled_at: new Date().toISOString() });
        insertSyncLog(db, { event_id: event.id, action: 'pull', detail: { from: 'ready', to: 'loaded' } });
      }

      const edb = openEventDb(event.id, dataDir);
      const questions = edb.prepare(
        'SELECT id, text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index ASC'
      ).all();

      const metaRows = edb.prepare('SELECT key, value FROM event_meta').all();
      const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

      // Bundle users : uniquement les rôles borne (admin_borne, tech_borne).
      // Le rôle 'general' n'est pas pullé — son auth est proxiée vers le Hub à chaque login (§11.24).
      const assignedUsers = db.prepare(`
        SELECT u.email, u.password_hash, eu.roles
        FROM event_users eu
        INNER JOIN users u ON u.id = eu.user_id
        WHERE eu.event_id = ? AND u.active = 1 AND u.password_hash IS NOT NULL
        ORDER BY u.email
      `).all(event.id).map(u => ({ email: u.email, password_hash: u.password_hash, roles: JSON.parse(u.roles) }));

      const superuserEmails = new Set(
        db.prepare(`SELECT email FROM users WHERE role = 'superuser' AND active = 1`).all().map(u => u.email)
      );

      const superusers = db.prepare(`
        SELECT email, password_hash FROM users
        WHERE role = 'superuser' AND active = 1
      `).all().map(u => ({ email: u.email, password_hash: u.password_hash, roles: ['admin_borne', 'tech_borne'] }));

      // Fusionner : les superusers remplacent leurs éventuels rôles restreints dans event_users.
      // Filtrer les rôles 'general' des assignés non-superusers.
      const assignedNonSuperusers = assignedUsers
        .filter(u => !superuserEmails.has(u.email))
        .map(u => ({ ...u, roles: u.roles.filter(r => r !== 'general') }))
        .filter(u => u.roles.length > 0);

      const usersWithHash = [...assignedNonSuperusers, ...superusers];

      // requiresLogin : vrai si au moins un user 'general' est assigné (auth wall preview via Hub)
      const hasGeneral = db.prepare(`
        SELECT COUNT(*) AS n FROM event_users eu
        INNER JOIN users u ON u.id = eu.user_id
        WHERE eu.event_id = ? AND u.active = 1
          AND eu.roles LIKE '%general%'
      `).get(event.id).n > 0;

      // Assets du design appliqué (§9bis). Le reste du bundle est du texte ; les
      // images sont des binaires, donc on n'envoie ici que leur manifest — la
      // borne les télécharge ensuite une par une et vérifie chaque checksum.
      const designDir = join(evDir(dataDir, event.id), 'design');
      const design_assets = [];
      if (existsSync(designDir)) {
        for (const filename of readdirSync(designDir)) {
          const path = join(designDir, filename);
          if (!statSync(path).isFile()) continue;
          design_assets.push({
            filename,
            size: statSync(path).size,
            checksum: await sha256File(path),
          });
        }
      }

      const freshEvent = getEvent(db, event.id);
      syncLog(req, 200, `name="${event.name}"  questions=${questions.length}  users=${usersWithHash.length}  status=${freshEvent.status}  requiresLogin=${hasGeneral}  design_assets=${design_assets.length}`);
      res.json({
        event: { ...freshEvent, meta },
        questions,
        users: usersWithHash,
        requiresLogin: hasGeneral,
        design_assets,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/sync/events/:id/design/:filename ────────────────────────────
  // Télécharge un asset du design appliqué. Anti path-traversal : le filename
  // doit figurer dans le listing réel du dossier — on ne concatène jamais un
  // paramètre d'URL pour construire un chemin sans l'avoir confronté au disque.
  router.get('/events/:id/design/:filename', validateUuidParams('id'), (req, res, next) => {
    try {
      if (req.params.id !== req.box.event_id) {
        return res.status(403).json({ error: 'Token non autorisé sur cet événement' });
      }

      // Double garde, homogène avec les surfaces kiosque : la forme du filename
      // est vérifiée en plus de sa présence dans le listing réel du dossier.
      if (!isValidAssetFilename(req.params.filename)) {
        return res.status(404).json({ error: 'Asset introuvable' });
      }

      const designDir = join(evDir(dataDir, req.params.id), 'design');
      if (!existsSync(designDir)) return res.status(404).json({ error: 'Aucun asset' });

      const known = readdirSync(designDir);
      if (!known.includes(req.params.filename)) {
        return res.status(404).json({ error: 'Asset introuvable' });
      }

      res.sendFile(join(designDir, req.params.filename));
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/events/:id/status (heartbeat) ─────────────────────────
  router.post('/events/:id/status', validateUuidParams('id'), (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['live', 'closed'].includes(status)) {
        return res.status(400).json({ error: 'status doit être live ou closed' });
      }

      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (req.params.id !== req.box.event_id) return res.status(403).json({ error: 'Non assigné à cette borne' });

      if (statusRank(status) <= statusRank(event.status)) {
        syncLog(req, 409, `transition ${event.status}→${status} refusée`);
        return res.status(409).json({ error: `Transition ${event.status}→${status} non autorisée (retour en arrière)` });
      }

      updateEvent(db, event.id, { status });
      insertSyncLog(db, { event_id: event.id,  action: 'status', detail: { from: event.status, to: status } });

      syncLog(req, 200, `${event.status}→${status}`);
      res.json({ ok: true, status });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/events/:id/manifest ───────────────────────────────────
  // body: { files: [{ video_id, filename, size, checksum }], db: { size, checksum } }
  // réponse: { missing: [video_id…] } — rend le push idempotent/reprenable (§11.12)
  router.post('/events/:id/manifest', validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (req.params.id !== req.box.event_id) return res.status(403).json({ error: 'Non assigné à cette borne' });
      if (!['closed', 'pushed'].includes(event.status)) {
        return res.status(409).json({ error: `Statut ${event.status} — push non disponible (événement non clôturé)` });
      }

      const { files, db: dbMeta } = req.body;
      if (!Array.isArray(files) || !dbMeta) {
        return res.status(400).json({ error: 'body invalide : files[] et db requis' });
      }

      const videosDir = join(evDir(dataDir, event.id), 'videos');
      const missing = [];

      for (const f of files) {
        const ok = await videoAlreadyReceived(videosDir, f.video_id, f.checksum);
        if (!ok) missing.push(f.video_id);
      }

      // Persiste le manifest pour que finalize puisse vérifier la complétude
      writeFileSync(manifestPath(dataDir, event.id), JSON.stringify({ files, db: dbMeta }));
      insertSyncLog(db, { event_id: event.id,  action: 'push_manifest', detail: { total: files.length, missing: missing.length } });

      syncLog(req, 200, `total=${files.length}  missing=${missing.length}`);
      res.json({ missing });
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/sync/events/:id/files/:videoId ───────────────────────────────
  // Upload multipart d'UN fichier vidéo ; Hub recalcule sha256, 422 si mismatch
  router.put('/events/:id/files/:videoId', validateUuidParams('id', 'videoId'), uploadVideo.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ error: 'Événement introuvable' });
      }
      if (req.params.id !== req.box.event_id) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(403).json({ error: 'Non assigné à cette borne' });
      }
      if (!['closed', 'pushed'].includes(event.status)) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(409).json({ error: `Statut ${event.status} — upload non disponible` });
      }

      // Récupère le checksum attendu depuis le manifest (si présent)
      const mPath = manifestPath(dataDir, event.id);
      let expectedChecksum = null;
      if (existsSync(mPath)) {
        const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
        const entry = manifest.files.find(f => f.video_id === req.params.videoId);
        if (entry) expectedChecksum = entry.checksum;
      }

      const actual = await sha256File(req.file.path);

      if (expectedChecksum && actual !== expectedChecksum) {
        // Supprime le fichier corrompu
        try { unlinkSync(req.file.path); } catch {}
        return res.status(422).json({ error: 'Checksum mismatch — fichier corrompu, réessayez' });
      }

      insertSyncLog(db, { event_id: event.id,  action: 'push_file', detail: { video_id: req.params.videoId, size: req.file.size } });
      syncLog(req, 200, `video_id=${req.params.videoId.slice(0, 8)}…  size=${req.file.size}`);
      res.json({ ok: true, video_id: req.params.videoId, checksum: actual });
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/sync/events/:id/db ───────────────────────────────────────────
  // Upload du db.sqlite final. Ferme d'abord le handle LRU (§11.11).
  router.put('/events/:id/db', validateUuidParams('id'), uploadDbFile.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ error: 'Événement introuvable' });
      }
      if (req.params.id !== req.box.event_id) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(403).json({ error: 'Non assigné à cette borne' });
      }
      if (!['closed', 'pushed'].includes(event.status)) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(409).json({ error: `Statut ${event.status} — upload db non disponible` });
      }

      // Vérification checksum si manifest présent
      const mPath = manifestPath(dataDir, event.id);
      let expectedChecksum = null;
      if (existsSync(mPath)) {
        const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
        if (manifest.db) expectedChecksum = manifest.db.checksum;
      }

      const actual = await sha256File(req.file.path);

      if (expectedChecksum && actual !== expectedChecksum) {
        try { unlinkSync(req.file.path); } catch {}
        return res.status(422).json({ error: 'Checksum db.sqlite mismatch — réessayez' });
      }

      // §11.11 : fermer le handle AVANT d'écraser le fichier
      closeEventDb(event.id);

      // Nettoie les fichiers WAL/SHM résiduels pour éviter la corruption post-remplacement
      const dest = join(evDir(dataDir, event.id), 'db.sqlite');
      try { unlinkSync(dest + '-wal'); } catch {}
      try { unlinkSync(dest + '-shm'); } catch {}

      // Remplace atomiquement db.sqlite
      renameSync(req.file.path, dest);

      insertSyncLog(db, { event_id: event.id,  action: 'push_db', detail: { checksum: actual } });
      syncLog(req, 200, `checksum=${actual.slice(0, 12)}…`);
      res.json({ ok: true, checksum: actual });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/events/:id/finalize ───────────────────────────────────
  // Vérifie que tout le manifest est reçu, passe en pushed, enfile les jobs.
  router.post('/events/:id/finalize', validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (req.params.id !== req.box.event_id) return res.status(403).json({ error: 'Non assigné à cette borne' });
      if (!['closed', 'pushed'].includes(event.status)) {
        return res.status(409).json({ error: `Statut ${event.status} — finalize non disponible` });
      }

      // Vérifie que le manifest existe et que tous les fichiers sont présents
      const mPath = manifestPath(dataDir, event.id);
      if (!existsSync(mPath)) {
        return res.status(409).json({ error: 'Manifest absent — lancez POST /manifest d\'abord' });
      }

      const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
      const videosDir = join(evDir(dataDir, event.id), 'videos');

      // Recalcul des missing (invariant §11.12 — ne jamais faire confiance au push_state local)
      const stillMissing = [];
      for (const f of manifest.files) {
        const ok = await videoAlreadyReceived(videosDir, f.video_id, f.checksum);
        if (!ok) stillMissing.push(f.video_id);
      }

      // Vérifie que db.sqlite a bien été reçu
      const dbPath = join(evDir(dataDir, event.id), 'db.sqlite');
      if (!existsSync(dbPath)) {
        return res.status(409).json({ error: 'db.sqlite absent' });
      }

      if (stillMissing.length > 0) {
        return res.status(409).json({ error: 'Fichiers manquants', missing: stillMissing });
      }

      // Idempotence : si déjà pushed, ne pas ré-enfiler les jobs (évite doublons worker)
      if (event.status === 'pushed') {
        const existingJobs = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE event_id = ?').get(event.id).n;
        syncLog(req, 200, `already pushed  jobs=${existingJobs}`);
        return res.json({ ok: true, jobs: existingJobs, alreadyPushed: true });
      }

      // Enfile les jobs (probe + thumbnail par vidéo + archive) — uniquement au premier finalize
      const jobsToCreate = [];
      for (const f of manifest.files) {
        jobsToCreate.push({ event_id: event.id, video_id: f.video_id, type: 'probe' });
        jobsToCreate.push({ event_id: event.id, video_id: f.video_id, type: 'thumbnail' });
      }
      jobsToCreate.push({ event_id: event.id, video_id: null, type: 'archive' });

      const insertJob = db.prepare(
        'INSERT INTO jobs (event_id, video_id, type) VALUES (?, ?, ?)'
      );
      const insertAll = db.transaction(() => {
        for (const j of jobsToCreate) insertJob.run(j.event_id, j.video_id, j.type);
      });
      insertAll();

      // Passe en pushed
      updateEvent(db, event.id, { status: 'pushed', pushed_at: new Date().toISOString() });
      insertSyncLog(db, { event_id: event.id,  action: 'finalize', detail: { videos: manifest.files.length, jobs: jobsToCreate.length } });

      syncLog(req, 200, `videos=${manifest.files.length}  jobs=${jobsToCreate.length}`);
      res.json({ ok: true, jobs: jobsToCreate.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
