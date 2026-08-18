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

// Comparaison à temps constant pour le PIN (§S5.2/L2)
function safeCompare(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Login : { pin } — code à 6 chiffres partagé contre event_meta de l'événement
// actif, pullé depuis le Hub. Pas de compte nominatif pour admin_borne NI
// tech_borne (cf. PROJET.md) : on essaie tech_pin (rôle le plus élevé) avant
// admin_pin. Aucun autre chemin : plus de TECH_PASSWORD (retiré) — la fenêtre
// avant le premier pull (aucun PIN encore disponible) est couverte par
// `POST /sync/onboarding/pair`, qui ouvre directement une session tech_borne
// dès que le token borne est validé par le Hub (cf. routes/sync.js).
//
// Angle mort connu (review Phase D, non corrigé ici) : cette route reste
// joignable sans garde previewMode, donc depuis Internet sur une borne
// d'essai (`docker/preview-nginx.conf` proxifie tout `/api/`) — avec le même
// `admin_pin`/`tech_pin` que la borne réelle (transporté tel quel dans le
// bundle). 6 chiffres derrière un rate-limit par IP a minima redevenu
// opérant (cf. `trust proxy` correct en preview, config.js), mais reste la
// seule protection. Bloquer purement et simplement casserait l'usage
// légitime (le client teste sa borne d'essai à distance) sans rien offrir en
// échange : la vraie correction est ROADMAP.md Phase D.4bis
// (`event_meta.preview_pin`, valeur DISTINCTE d'`admin_pin`, pour que ce
// PIN-là ne donne jamais accès aux vraies vidéos d'invités sur la borne
// réelle) — pas un patch ponctuel ici.
export function makeAuthRouter(config, dataDir) {
  return async function loginHandler(req, res, next) {
    try {
      const { pin } = req.body;
      if (pin === undefined) return res.status(401).json({ error: 'Identifiants incorrects' });

      const activeEvent = getActiveEvent();
      const edb = activeEvent ? getActiveEventDb(dataDir, activeEvent) : null;

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
