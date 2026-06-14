import { Router } from 'express';
import { createReadStream, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../registry.js';
import { openEventDb } from '../eventStore.js';
import { requireUser, requireOwner } from '../middleware/auth.js';

const PUSHED_STATUSES = new Set(['pushed', 'processed']);

export function makeGalleryRouter(dataDir) {
  const router = Router({ mergeParams: true });

  // Tous les endpoints nécessitent une authentification + ownership
  router.use(requireUser, requireOwner);

  // Vérifie que l'événement est au moins en statut pushed
  function requirePushed(req, res, next) {
    if (!PUSHED_STATUSES.has(req.event.status)) {
      return res.status(409).json({ error: 'Galerie disponible uniquement après le push' });
    }
    next();
  }

  // Helper : stream Range-aware d'un fichier
  function streamFile(res, filePath, contentType) {
    const stat = statSync(filePath);
    const { size } = stat;
    const range = res.req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': size,
        'Content-Type': contentType,
      });
      createReadStream(filePath).pipe(res);
    }
  }

  // Neutralise les préfixes de formule CSV (§S4/M1) : un prénom `=cmd|'/c calc'!A1`
  // s'exécuterait à l'ouverture dans Excel/LibreOffice. On préfixe d'une apostrophe.
  const sanitizeCsv = (v) => {
    const s = String(v ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  };
  const escapeCsv = (v) => `"${sanitizeCsv(v).replace(/"/g, '""')}"`;

  // ── GET /api/events/:eventId/videos/export/csv ─── (AVANT /:videoId §11.1)
  router.get('/videos/export/csv', requirePushed, (req, res) => {
    const edb = openEventDb(req.params.eventId, dataDir);
    const videos = edb.prepare(`
      SELECT v.id, v.filename, v.question_text, v.mime_type, v.size, v.checksum,
             v.recorded_at, v.uploaded_at,
             s.guest_name, s.consent_at,
             d.duration_s, d.width, d.height
      FROM videos v
      JOIN sessions s ON s.id = v.session_id
      LEFT JOIN derived d ON d.video_id = v.id
      ORDER BY v.uploaded_at ASC
    `).all();

    const lines = [
      ['id', 'filename', 'question_text', 'guest_name', 'consent_at', 'recorded_at',
       'size', 'duration_s', 'width', 'height'].join(','),
      ...videos.map((v) =>
        [v.id, v.filename, escapeCsv(v.question_text), escapeCsv(v.guest_name),
         v.consent_at, v.recorded_at, v.size, v.duration_s ?? '', v.width ?? '', v.height ?? '']
          .join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-${req.params.eventId}-videos.csv"`);
    res.send(lines.join('\r\n'));
  });

  // ── GET /api/events/:eventId/videos ───────────────────────────────────────
  router.get('/videos', requirePushed, (req, res) => {
    const edb = openEventDb(req.params.eventId, dataDir);
    const videos = edb.prepare(`
      SELECT v.id, v.filename, v.question_text, v.mime_type, v.size,
             v.recorded_at, v.uploaded_at,
             s.guest_name,
             d.thumbnail, d.duration_s, d.width, d.height
      FROM videos v
      JOIN sessions s ON s.id = v.session_id
      LEFT JOIN derived d ON d.video_id = v.id
      ORDER BY v.uploaded_at ASC
    `).all();
    res.json(videos);
  });

  // ── GET /api/events/:eventId/videos/:videoId/file ─────────────────────────
  router.get('/videos/:videoId/file', requirePushed, (req, res, next) => {
    try {
      const edb = openEventDb(req.params.eventId, dataDir);
      const video = edb.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      const filePath = join(dataDir, 'events', req.params.eventId, 'videos', video.filename);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Fichier absent' });

      streamFile(res, filePath, video.mime_type ?? 'video/mp4');
    } catch (err) { next(err); }
  });

  // ── GET /api/events/:eventId/videos/:videoId/download ────────────────────
  router.get('/videos/:videoId/download', requirePushed, (req, res, next) => {
    try {
      const edb = openEventDb(req.params.eventId, dataDir);
      const video = edb.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      const filePath = join(dataDir, 'events', req.params.eventId, 'videos', video.filename);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Fichier absent' });

      res.setHeader('Content-Disposition', `attachment; filename="${video.filename}"`);
      streamFile(res, filePath, video.mime_type ?? 'video/mp4');
    } catch (err) { next(err); }
  });

  // ── GET /api/events/:eventId/videos/:videoId/thumbnail ───────────────────
  router.get('/videos/:videoId/thumbnail', requirePushed, (req, res, next) => {
    try {
      const edb = openEventDb(req.params.eventId, dataDir);
      const derived = edb.prepare('SELECT thumbnail FROM derived WHERE video_id = ?').get(req.params.videoId);
      if (!derived?.thumbnail) return res.status(404).json({ error: 'Miniature non disponible' });

      const thumbPath = join(dataDir, 'events', req.params.eventId, 'derived', derived.thumbnail);
      if (!existsSync(thumbPath)) return res.status(404).json({ error: 'Fichier miniature absent' });

      res.setHeader('Content-Type', 'image/jpeg');
      createReadStream(thumbPath).pipe(res);
    } catch (err) { next(err); }
  });

  // ── GET /api/events/:eventId/archive ─────────────────────────────────────
  router.get('/archive', requirePushed, (req, res, next) => {
    try {
      const db = getDb();
      const archiveJob = db.prepare(`
        SELECT * FROM jobs
        WHERE event_id = ? AND type = 'archive'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(req.params.eventId);

      const zipPath = join(dataDir, 'events', req.params.eventId, 'derived', 'archive.zip');

      if (!archiveJob || archiveJob.status !== 'done' || !existsSync(zipPath)) {
        return res.status(202).json({ pending: true });
      }

      res.setHeader('Content-Disposition', `attachment; filename="event-${req.params.eventId}.zip"`);
      streamFile(res, zipPath, 'application/zip');
    } catch (err) { next(err); }
  });

  // ── DELETE /api/events/:eventId/videos/:videoId ───────────────────────────
  router.delete('/videos/:videoId', requirePushed, (req, res, next) => {
    try {
      const edb = openEventDb(req.params.eventId, dataDir);
      const video = edb.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'Vidéo introuvable' });

      // Supprime le fichier physique
      const filePath = join(dataDir, 'events', req.params.eventId, 'videos', video.filename);
      if (existsSync(filePath)) unlinkSync(filePath);

      // Supprime en base (derived en cascade grâce à ON DELETE CASCADE)
      edb.prepare('DELETE FROM videos WHERE id = ?').run(req.params.videoId);

      // Invalide l'archive : ré-enfile un job 'archive'
      const db = getDb();
      db.prepare(`
        INSERT INTO jobs (event_id, type, status)
        VALUES (?, 'archive', 'pending')
      `).run(req.params.eventId);

      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
