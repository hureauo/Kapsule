import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import { getDb, listBoxes, insertBox, deleteBox, getBoxByTokenHash } from '../registry.js';
import { requireUser } from '../middleware/auth.js';

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux admins' });
  next();
}

/** Calcule récursivement la taille d'un dossier en octets. */
function dirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else {
        try { total += statSync(full).size; } catch { /* fichier disparu */ }
      }
    }
  } catch { /* dossier absent */ }
  return total;
}

export function makeAdminRouter(dataDir) {
  const router = Router();
  router.use(requireUser, requireAdmin);

  // POST /api/admin/boxes — crée une borne ; retourne le token en clair UNE SEULE FOIS
  router.post('/boxes', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requis' });

    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');

    const db = getDb();
    // Collision très improbable mais on vérifie
    if (getBoxByTokenHash(db, token_hash)) {
      return res.status(500).json({ error: 'Collision de token, réessayez' });
    }

    const result = insertBox(db, { name: name.trim(), token_hash });
    res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), token });
  });

  // GET /api/admin/boxes — liste toutes les bornes (sans token)
  router.get('/boxes', (req, res) => {
    const db = getDb();
    const boxes = listBoxes(db).map(({ token_hash: _t, ...b }) => b);
    res.json(boxes);
  });

  // DELETE /api/admin/boxes/:id
  router.delete('/boxes/:id', (req, res) => {
    const db = getDb();
    const result = deleteBox(db, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Borne introuvable' });
    res.status(204).end();
  });

  // GET /api/admin/overview
  router.get('/overview', async (req, res, next) => {
    try {
      const db = getDb();

      // Tous les événements (tous clients)
      const events = db.prepare(`
        SELECT e.id, e.name, e.status, e.owner_id, e.created_at, e.pushed_at, e.processed_at,
               u.email AS owner_email
        FROM events e
        LEFT JOIN users u ON u.id = e.owner_id
        ORDER BY e.created_at DESC
      `).all();

      // Calcul de la taille disque par événement
      const eventsWithSize = events.map((ev) => ({
        ...ev,
        disk_bytes: dirSize(join(dataDir, 'events', ev.id)),
      }));

      // Disque libre du volume contenant dataDir
      const fsStats = await statfs(dataDir);
      const disk_free_bytes = fsStats.bfree * fsStats.bsize;
      const disk_total_bytes = fsStats.blocks * fsStats.bsize;

      // Jobs failed récents (20 derniers)
      const failed_jobs = db.prepare(`
        SELECT j.id, j.event_id, j.video_id, j.type, j.error, j.attempts,
               j.created_at, j.finished_at
        FROM jobs j
        WHERE j.status = 'failed'
        ORDER BY j.finished_at DESC
        LIMIT 20
      `).all();

      // Bornes avec last_seen_at
      const boxes = db.prepare(`
        SELECT id, name, last_seen_at, created_at
        FROM boxes
        ORDER BY created_at DESC
      `).all();

      res.json({
        events: eventsWithSize,
        disk: { free_bytes: disk_free_bytes, total_bytes: disk_total_bytes },
        failed_jobs,
        boxes,
      });
    } catch (err) { next(err); }
  });

  return router;
}
