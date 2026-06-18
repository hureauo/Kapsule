import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import { getActiveEvent } from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  return (
    (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
    req.query.token ??
    null
  );
}

// Comparaison à temps constant pour le fallback mot de passe env (§S5.2/L2)
function safeCompare(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Login : { email, password } contre event_users de l'événement actif.
// Si aucun user en base → fallback sur TECH_PASSWORD env (mode autonome).
export function makeAuthRouter(config, dataDir) {
  return async function loginHandler(req, res, next) {
    try {
      const { email, password } = req.body;
      if (!password) return res.status(401).json({ error: 'Identifiants incorrects' });

      const activeEvent = getActiveEvent();
      const edb = activeEvent ? getActiveEventDb(dataDir, activeEvent) : null;
      const users = edb ? edb.prepare('SELECT * FROM event_users').all() : [];

      if (users.length > 0) {
        // Auth par compte nominatif (pull depuis Hub)
        if (!email) return res.status(401).json({ error: 'Identifiants incorrects' });
        const user = users.find(u => u.email === email);
        if (!user || !user.password_hash) {
          return res.status(401).json({ error: 'Identifiants incorrects' });
        }
        const valid = await argon2.verify(user.password_hash, password);
        if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });
        const roles = JSON.parse(user.roles);
        const token = jwt.sign({ email: user.email, roles }, config.jwtSecret, { expiresIn: '24h' });
        return res.json({ token });
      }

      // Fallback mode autonome : TECH_PASSWORD env
      const techPwd = config.techPassword;
      if (!techPwd || !safeCompare(password, techPwd)) {
        return res.status(401).json({ error: 'Identifiants incorrects' });
      }
      const token = jwt.sign({ roles: ['tech_borne'] }, config.jwtSecret, { expiresIn: '24h' });
      return res.json({ token });
    } catch (err) {
      next(err);
    }
  };
}

// requireRole(requiredRole) : vérifie que le JWT contient le rôle requis.
// admin_borne est accessible à tech_borne (sur-ensemble, §11.19).
// Accepte ?token= pour les <video src> et downloads (§11.2).
export function requireRole(requiredRole) {
  return function (config) {
    return function (req, res, next) {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ error: 'Token manquant' });
      try {
        const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        const roles = Array.isArray(payload.roles) ? payload.roles : [];
        const hasRole =
          requiredRole === 'admin_borne'
            ? roles.includes('admin_borne') || roles.includes('tech_borne')
            : roles.includes(requiredRole);
        if (!hasRole) return res.status(403).json({ error: 'Accès refusé' });

        // Si le JWT est scopé à un événement précis (émis par le Hub pour la preview),
        // vérifier que la borne sert bien cet événement — cloisonnement cross-preview.
        if (payload.event_id) {
          const active = getActiveEvent();
          if (!active || active.id !== payload.event_id) {
            return res.status(403).json({ error: 'Token non valide pour cet événement' });
          }
        }

        req.admin = payload;
        next();
      } catch {
        res.status(401).json({ error: 'Token invalide ou expiré' });
      }
    };
  };
}

// Alias nommés pour la compatibilité avec les routes existantes
export const requireAdmin = requireRole('admin_borne');
export const requireTech = requireRole('tech_borne');
