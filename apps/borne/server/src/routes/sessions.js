import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { validateGuestName } from '@kapsule/core';
import { getActiveEvent, updateEventStatus } from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';

export function makeSessionsRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;

  function requireActiveDb(res) {
    const active = getActiveEvent();
    if (!active) {
      res.status(404).json({ error: 'Aucun événement actif' });
      return null;
    }
    return { active, db: getActiveEventDb(dataDir, active) };
  }

  // ── Routes publiques ──────────────────────────────────────────────────────

  router.post('/sessions', (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { active, db } = ctx;

      // Preview avec users general : vérifier JWT general avant de créer la session
      if (active.is_preview) {
        const users = db.prepare('SELECT roles FROM event_users').all();
        const hasGeneral = users.some(u => {
          try { return JSON.parse(u.roles).includes('general'); } catch { return false; }
        });
        if (hasGeneral) {
          const authHeader = req.headers['authorization'];
          const token = (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ?? req.query.token ?? null;
          if (!token) return res.status(401).json({ error: 'Login requis pour accéder à cet événement' });
          try {
            const payload = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] });
            const roles = Array.isArray(payload.roles) ? payload.roles : [];
            const allowed = ['general', 'admin_borne', 'tech_borne'];
            if (!roles.some(r => allowed.includes(r))) return res.status(403).json({ error: 'Accès refusé' });
          } catch {
            return res.status(401).json({ error: 'Token invalide ou expiré' });
          }
        }
      }

      const { guest_name, consent } = req.body;

      // Événement clôturé : plus de nouvelles sessions (spec §8, §6)
      if (active.status === 'closed') {
        return res.status(409).json({ error: 'event_closed', message: "L'événement est terminé" });
      }

      // Invariant RGPD : consent doit être exactement true (booléen)
      if (consent !== true) {
        return res.status(400).json({ error: 'Le consentement est obligatoire' });
      }

      const nameErr = validateGuestName(guest_name);
      if (nameErr) return res.status(400).json({ error: nameErr });

      // Passage live si c'est la première session
      const sessionCount = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
      if (sessionCount === 0 && active.status === 'loaded') {
        updateEventStatus(active.id, 'live');
      }

      const id = uuidv4();
      db.prepare(
        'INSERT INTO sessions (id, guest_name, consent_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(id, guest_name.trim());

      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  // Le UUID de session fait office de capability token — pas besoin d'auth supplémentaire
  router.get('/sessions/:id/answers', (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { db } = ctx;
      const { id } = req.params;

      const session = db.prepare('SELECT id FROM sessions WHERE id=?').get(id);
      if (!session) return res.status(404).json({ error: 'Session introuvable' });

      const answers = db.prepare(
        'SELECT question_id, id as video_id, recorded_at FROM videos WHERE session_id=?'
      ).all(id);
      res.json(answers);
    } catch (err) {
      next(err);
    }
  });

  router.put('/sessions/:id/complete', (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { db } = ctx;
      const { id } = req.params;

      const session = db.prepare('SELECT id FROM sessions WHERE id=?').get(id);
      if (!session) return res.status(404).json({ error: 'Session introuvable' });

      db.prepare(
        'UPDATE sessions SET completed_at=CURRENT_TIMESTAMP WHERE id=?'
      ).run(id);
      res.json(db.prepare('SELECT * FROM sessions WHERE id=?').get(id));
    } catch (err) {
      next(err);
    }
  });

  // ── Route admin ────────────────────────────────────────────────────────────

  router.get('/sessions', auth, (req, res, next) => {
    try {
      const ctx = requireActiveDb(res);
      if (!ctx) return;
      const { db } = ctx;

      const sessions = db.prepare(`
        SELECT s.*, COUNT(v.id) as video_count
        FROM sessions s
        LEFT JOIN videos v ON v.session_id = s.id
        GROUP BY s.id
        ORDER BY s.started_at DESC
      `).all();
      res.json(sessions);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
