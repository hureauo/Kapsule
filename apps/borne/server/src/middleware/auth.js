import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';

// Comparaison à temps constant pour résister aux attaques par timing (§S5.2/L2)
function safeCompare(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Login : compare les deux mots de passe (toujours évalués, sans court-circuit) pour éviter
// les attaques par timing sur la sélection du rôle. Signe 'client' ou 'tech' selon le mot de passe.
export function makeAuthRouter(config) {
  return async function loginHandler(req, res, next) {
    try {
      const { password } = req.body;
      if (!password) return res.status(401).json({ error: 'Mot de passe incorrect' });
      const isClient = safeCompare(password, config.adminPassword);
      const isTech = safeCompare(password, config.techPassword);
      if (!isClient && !isTech) {
        return res.status(401).json({ error: 'Mot de passe incorrect' });
      }
      const role = isClient ? 'client' : 'tech';
      const token = jwt.sign({ role }, config.jwtSecret, { expiresIn: '24h' });
      res.json({ token });
    } catch (err) {
      next(err);
    }
  };
}

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  return (
    (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
    req.query.token ??
    null
  );
}

// requireAdmin : accepte 'client' OU 'tech' (le tech est un sur-ensemble du client, §11.19)
export function requireAdmin(config) {
  return function (req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (payload.role !== 'client' && payload.role !== 'tech') {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      req.admin = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  };
}

// requireTech : réservé au technicien (préflight, clôture, synchro) — §11.19
// Un token 'client' reçoit 403, pas 401.
export function requireTech(config) {
  return function (req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (payload.role !== 'tech') {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      req.admin = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  };
}
