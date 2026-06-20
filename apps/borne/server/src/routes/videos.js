import { Router } from 'express';
import { createReadStream, unlink, readdirSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { sha256File } from '@kapsule/core/src/checksum.js';
import { LIMITS } from '@kapsule/core';
import { getActiveEvent } from '../registry.js';
import { config } from '../config.js';
import { getActiveEventDb } from '../eventDb.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else total += statSync(full).size;
    }
  } catch { /* dir inexistant ou inaccessible */ }
  return total;
}

function makeMulter(dataDir) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const active = getActiveEvent();
      if (!active) return cb(new Error('Aucun événement actif'));
      cb(null, join(dataDir, 'events', active.id, 'videos'));
    },
    filename(req, file, cb) {
      const ext = extname(file.originalname).toLowerCase() || '.mp4';
      cb(null, `${uuidv4()}${ext}`);
    },
  });

  // fileFilter : tolère video/* ET les mimes génériques Safari avec extension vidéo (§11.4)
  const fileFilter = (req, file, cb) => {
    const mime = file.mimetype;
    const ext = extname(file.originalname).toLowerCase();
    const isVideoMime = mime.startsWith('video/');
    const isGenericMime = mime === 'text/plain' || mime === 'application/octet-stream';
    if (isVideoMime || (isGenericMime && VIDEO_EXTENSIONS.has(ext))) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Type de fichier non supporté'), { status: 400 }));
    }
  };

  return multer({ storage, fileFilter, limits: { fileSize: LIMITS.VIDEO_MAX_BYTES } });
}

// Envoie un fichier en respectant les Range requests (§11.3) — nécessaire pour le scrubbing
async function streamFile(res, filePath, forceAttachment = false) {
  let fileSize;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return res.status(404).json({ error: 'Fichier introuvable' });
  }

  const range = res.req.headers.range;

  if (forceAttachment) {
    res.setHeader('Content-Disposition', `attachment; filename="${filePath.split('/').pop()}"`);
  }

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    return createReadStream(filePath).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', chunkSize);
  createReadStream(filePath, { start, end }).pipe(res);
}

export function makeVideosRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;
  const upload = makeMulter(dataDir);

  // Instancié par routeur pour éviter la pollution entre suites de tests (état en mémoire)
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop d\'uploads, réessayez dans 15 minutes.' },
    skip: () => cfg.skipRateLimits === true,
  });

  function blockInPreview(req, res, next) {
    if (cfg.previewMode) return res.status(403).json({ error: 'Non disponible en mode preview' });
    next();
  }

  function checkQuota(req, res, next) {
    const maxBytes = cfg.maxDataBytes ?? config.maxDataBytes;
    if (!maxBytes) return next();
    const eventsDir = join(dataDir, 'events');
    if (dirSize(eventsDir) >= maxBytes) {
      return res.status(507).json({ error: 'Espace de stockage insuffisant (quota MAX_DATA_BYTES atteint)' });
    }
    next();
  }

  function requireActiveDb(res) {
    const active = getActiveEvent();
    if (!active) {
      res.status(404).json({ error: 'Aucun événement actif' });
      return null;
    }
    return { active, db: getActiveEventDb(dataDir, active) };
  }

  // ── Upload public ─────────────────────────────────────────────────────────

  router.post('/videos', uploadLimiter, checkQuota, upload.single('video'), async (req, res, next) => {
    // multer a déjà stocké le fichier sur disque si on arrive ici
    const ctx = requireActiveDb(res);
    if (!ctx) {
      if (req.file) unlink(req.file.path, () => {});
      return;
    }
    const { active, db } = ctx;
    const { session_id, question_id, question_text, recorded_at } = req.body;

    // Vérifier req.file EN PREMIER — les guards suivants y accèdent via .path
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier vidéo requis' });
    }
    if (!session_id) {
      unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'session_id est requis' });
    }
    if (!question_text) {
      unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'question_text est requis' });
    }

    const session = db.prepare('SELECT id FROM sessions WHERE id=?').get(session_id);
    if (!session) {
      unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Session introuvable' });
    }

    // Plafond : au plus autant de vidéos que de questions par session
    const questionsCount = db.prepare('SELECT COUNT(*) as n FROM questions').get().n;
    if (questionsCount > 0) {
      const isReplacement = question_id
        ? db.prepare('SELECT 1 FROM videos WHERE session_id=? AND question_id=?').get(session_id, question_id)
        : null;
      if (!isReplacement) {
        const videosCount = db.prepare('SELECT COUNT(*) as n FROM videos WHERE session_id=?').get(session_id).n;
        if (videosCount >= questionsCount) {
          unlink(req.file.path, () => {});
          return res.status(429).json({ error: 'Plafond d\'uploads atteint pour cette session.' });
        }
      }
    }

    try {
      const checksum = await sha256File(req.file.path);
      const id = uuidv4();
      const filename = req.file.filename;
      const mime_type = req.file.mimetype.startsWith('video/') ? req.file.mimetype : 'video/mp4';
      const size = req.file.size;

      // Remplacement transactionnel §5.2 + §11.9 : DELETE+INSERT en transaction,
      // unlink de l'ancien fichier APRÈS commit
      let oldFilename = null;
      db.transaction(() => {
        if (question_id) {
          const existing = db.prepare(
            'SELECT filename FROM videos WHERE session_id=? AND question_id=?'
          ).get(session_id, question_id);
          if (existing) {
            oldFilename = existing.filename;
            db.prepare('DELETE FROM videos WHERE session_id=? AND question_id=?')
              .run(session_id, question_id);
          }
        }
        db.prepare(`
          INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, session_id, question_id ?? null, question_text, filename,
          mime_type, size, checksum, recorded_at ?? new Date().toISOString()
        );
      })();

      // unlink après commit (§11.9)
      if (oldFilename) {
        unlink(join(dataDir, 'events', active.id, 'videos', oldFilename), () => {});
      }

      const video = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
      res.status(201).json(video);
    } catch (err) {
      unlink(req.file.path, () => {});
      next(err);
    }
  });

  // ── Stream public (invité) ─────────────────────────────────────────────────

  router.get('/sessions/:sessionId/videos/:questionId/file', async (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { active, db } = ctx;
      const { sessionId, questionId } = req.params;

      const video = db.prepare(
        'SELECT * FROM videos WHERE session_id=? AND question_id=?'
      ).get(sessionId, questionId);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      const filePath = join(dataDir, 'events', active.id, 'videos', video.filename);
      res.setHeader('Content-Type', video.mime_type);
      await streamFile(res, filePath);
    } catch (err) {
      next(err);
    }
  });

  // ── Routes admin ──────────────────────────────────────────────────────────

  router.get('/videos', auth, (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { db } = ctx;
      const { session_id } = req.query;

      let sql = `SELECT v.*, s.guest_name FROM videos v
                 JOIN sessions s ON s.id = v.session_id`;
      const params = [];
      if (session_id) {
        sql += ' WHERE v.session_id=?';
        params.push(session_id);
      }
      sql += ' ORDER BY v.uploaded_at DESC';
      res.json(db.prepare(sql).all(...params));
    } catch (err) {
      next(err);
    }
  });

  // export/csv AVANT /:id (invariant §11.1)
  router.get('/videos/export/csv', auth, blockInPreview, (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { db } = ctx;

      const rows = db.prepare(`
        SELECT v.id, v.session_id, s.guest_name, s.consent_at,
               v.question_id, v.question_text, v.recorded_at, v.uploaded_at,
               v.size, v.filename, v.mime_type
        FROM videos v
        JOIN sessions s ON s.id = v.session_id
        ORDER BY v.uploaded_at DESC
      `).all();

      const headers = ['id','session_id','guest_name','consent_at','question_id',
                       'question_text','recorded_at','uploaded_at','size','filename','mime_type'];
      const sanitize = (v) => {
        const s = String(v ?? '');
        return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      };
      const escape = (v) => `"${sanitize(v).replace(/"/g, '""')}"`;

      const csv = [
        headers.join(','),
        ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
      ].join('\r\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="videos.csv"');
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.get('/videos/:id/file', auth, async (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { active, db } = ctx;
      const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });
      res.setHeader('Content-Type', video.mime_type);
      await streamFile(res, join(dataDir, 'events', active.id, 'videos', video.filename));
    } catch (err) {
      next(err);
    }
  });

  router.get('/videos/:id/download', auth, blockInPreview, async (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { active, db } = ctx;
      const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });
      res.setHeader('Content-Type', video.mime_type);
      await streamFile(res, join(dataDir, 'events', active.id, 'videos', video.filename), true);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/videos/:id', auth, (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { active, db } = ctx;
      const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      db.prepare('DELETE FROM videos WHERE id=?').run(req.params.id);
      unlink(join(dataDir, 'events', active.id, 'videos', video.filename), () => {});
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
