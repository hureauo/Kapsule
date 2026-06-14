import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { getDb, listBoxes, insertBox, deleteBox, getBoxByTokenHash } from '../registry.js';
import { requireUser } from '../middleware/auth.js';

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux admins' });
  next();
}

export function makeAdminRouter() {
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

  return router;
}
