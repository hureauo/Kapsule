import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';

// Comparaison à temps constant pour résister aux attaques par timing (§S5.2/L2)
function safeCompare(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function makeAuthRouter(config) {
  return async function loginHandler(req, res, next) {
    try {
      const { password } = req.body;
      if (!password || !safeCompare(password, config.adminPassword)) {
        return res.status(401).json({ error: 'Mot de passe incorrect' });
      }
      const token = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '24h' });
      res.json({ token });
    } catch (err) {
      next(err);
    }
  };
}

// Accepte Authorization: Bearer <token> OU ?token= (invariant §11.2 : <video src>, downloads, CSV)
export function requireAdmin(config) {
  return function (req, res, next) {
    const authHeader = req.headers['authorization'];
    const token =
      (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
      req.query.token ??
      null;

    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (payload.role !== 'admin') {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      req.admin = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  };
}
