import jwt from 'jsonwebtoken';
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

// Login : deux voies possibles.
//  1. { pin } — code à 6 chiffres partagé contre event_meta de l'événement actif,
//     pullé depuis le Hub. Pas de compte nominatif pour admin_borne NI tech_borne
//     (cf. PROJET.md) : on essaie tech_pin (rôle le plus élevé) avant admin_pin.
//  2. { password } seul — fallback TECH_PASSWORD env, actif tant que l'événement
//     (s'il y en a un) ne porte AUCUN PIN (mode autonome, avant le premier pull,
//     ou événement pullé d'un Hub antérieur à Phase C).
export function makeAuthRouter(config, dataDir) {
  return async function loginHandler(req, res, next) {
    try {
      const { password, pin } = req.body;

      const activeEvent = getActiveEvent();
      const edb = activeEvent ? getActiveEventDb(dataDir, activeEvent) : null;

      if (pin !== undefined) {
        const techRow = edb ? edb.prepare("SELECT value FROM event_meta WHERE key = 'tech_pin'").get() : null;
        if (techRow?.value && safeCompare(String(pin), techRow.value)) {
          const token = jwt.sign({ roles: ['tech_borne'] }, config.jwtSecret, { expiresIn: '24h' });
          return res.json({ token });
        }
        const adminRow = edb ? edb.prepare("SELECT value FROM event_meta WHERE key = 'admin_pin'").get() : null;
        if (adminRow?.value && safeCompare(String(pin), adminRow.value)) {
          const token = jwt.sign({ roles: ['admin_borne'] }, config.jwtSecret, { expiresIn: '24h' });
          return res.json({ token });
        }
        return res.status(401).json({ error: 'Identifiants incorrects' });
      }

      // Fallback TECH_PASSWORD : réservé au cas où l'événement actif n'a AUCUN PIN
      // configuré (mode autonome, borne fraîchement appairée avant le premier pull,
      // ou événement pullé depuis un Hub antérieur à Phase C). Dès qu'un tech_pin OU
      // un admin_pin existe sur l'événement actif, TECH_PASSWORD est refusé — sinon
      // il resterait une porte dérobée permanente y compris sur une borne appairée
      // (et sur une preview, où TECH_PASSWORD_PREVIEW est partagé par toutes les previews).
      const hasAnyPin = edb
        ? Boolean(edb.prepare("SELECT 1 FROM event_meta WHERE key IN ('admin_pin', 'tech_pin') LIMIT 1").get())
        : false;
      const techPwd = config.techPassword;
      if (hasAnyPin || !password || !techPwd || !safeCompare(password, techPwd)) {
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
