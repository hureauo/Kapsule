import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import {
  getDb,
  listUsers, insertUser, getUserById, updateUser,
  createRegistrationToken,
  insertBoxToken, listBoxTokensByEvent, getBoxTokenById, deleteBoxToken, updateBoxToken,
  getEvent,
} from '../registry.js';
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

  // ── Gestion des comptes clients ─────────────────────────────────────────────

  // POST /api/admin/users — crée un compte client sans mot de passe + lien d'enregistrement
  router.post('/users', async (req, res, next) => {
    try {
      const { email, name } = req.body;
      if (!email || !email.trim()) return res.status(400).json({ error: 'email requis' });

      const db = getDb();
      let result;
      try {
        result = insertUser(db, { email: email.trim(), name: name?.trim() ?? null, role: 'client' });
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email déjà utilisé' });
        throw e;
      }

      const userId = result.lastInsertRowid;
      const { token } = createRegistrationToken(db, { user_id: userId });
      const registration_url = `${req.protocol}://${req.get('host')}/register?token=${token}`;
      const user = getUserById(db, userId);
      const { password_hash: _, ...safeUser } = user;

      res.status(201).json({ user: { ...safeUser, has_password: false }, registration_url });
    } catch (err) { next(err); }
  });

  // GET /api/admin/users — liste des comptes clients
  router.get('/users', (req, res) => {
    const db = getDb();
    const users = listUsers(db).map((u) => ({
      ...u,
      has_password: u.password_hash != null,
    }));
    res.json(users);
  });

  // PUT /api/admin/users/:id — désactiver/réactiver, renommer
  router.put('/users/:id', (req, res) => {
    const db = getDb();
    const user = getUserById(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const { active, name } = req.body;
    const fields = {};
    if (active !== undefined) fields.active = active ? 1 : 0;
    if (name !== undefined) fields.name = name?.trim() ?? null;

    updateUser(db, req.params.id, fields);
    const updated = getUserById(db, req.params.id);
    const { password_hash: _, ...safe } = updated;
    res.json({ ...safe, has_password: updated.password_hash != null });
  });

  // POST /api/admin/users/:id/registration-link — génère un nouveau lien
  router.post('/users/:id/registration-link', async (req, res, next) => {
    try {
      const db = getDb();
      const user = getUserById(db, req.params.id);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      const { token } = createRegistrationToken(db, { user_id: user.id });
      const registration_url = `${req.protocol}://${req.get('host')}/register?token=${token}`;
      res.json({ registration_url });
    } catch (err) { next(err); }
  });

  // ── Tokens de borne (token = événement, §11.20) ──────────────────────────────

  // POST /api/admin/events/:id/tokens — génère un token ; retourne le clair UNE SEULE FOIS
  router.post('/events/:id/tokens', (req, res) => {
    const db = getDb();
    const event = getEvent(db, req.params.id);
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const { label, location, is_preview } = req.body;
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const result = insertBoxToken(db, {
      event_id: req.params.id,
      token_hash,
      label: label?.trim() ?? null,
      location: location?.trim() ?? null,
      is_preview: is_preview ? 1 : 0,
    });
    res.status(201).json({ id: result.lastInsertRowid, event_id: req.params.id, label, location, is_preview: is_preview ? 1 : 0, token });
  });

  // GET /api/admin/events/:id/tokens — liste sans hash
  router.get('/events/:id/tokens', (req, res) => {
    const db = getDb();
    res.json(listBoxTokensByEvent(db, req.params.id));
  });

  // DELETE /api/admin/tokens/:tokenId — révocation
  router.delete('/tokens/:tokenId', (req, res) => {
    const db = getDb();
    const result = deleteBoxToken(db, req.params.tokenId);
    if (result.changes === 0) return res.status(404).json({ error: 'Token introuvable' });
    res.status(204).end();
  });

  // PUT /api/admin/tokens/:tokenId — mise à jour label/location
  router.put('/tokens/:tokenId', (req, res) => {
    const db = getDb();
    const row = getBoxTokenById(db, req.params.tokenId);
    if (!row) return res.status(404).json({ error: 'Token introuvable' });
    updateBoxToken(db, req.params.tokenId, req.body);
    const updated = getBoxTokenById(db, req.params.tokenId);
    const { token_hash: _, ...safe } = updated;
    res.json(safe);
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

      // Tokens de borne (box_tokens) avec last_seen_at
      const box_tokens_overview = db.prepare(`
        SELECT id, event_id, label, location, is_preview, last_seen_at, created_at
        FROM box_tokens
        ORDER BY created_at DESC
      `).all();

      res.json({
        events: eventsWithSize,
        disk: { free_bytes: disk_free_bytes, total_bytes: disk_total_bytes },
        failed_jobs,
        boxes: box_tokens_overview,
      });
    } catch (err) { next(err); }
  });

  return router;
}
