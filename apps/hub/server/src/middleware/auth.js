import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb, getEvent, getEventUser } from '../registry.js';

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query.token) return req.query.token;
  return null;
}

export function requireUser(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// Vérifie que req.user est assigné à l'événement (ou superuser).
// Doit être appelé après requireUser et après avoir résolu eventId.
export function requireOwner(req, res, next) {
  const { eventId } = req.params;
  if (!eventId) return res.status(400).json({ error: 'eventId manquant' });
  const db = getDb();
  const event = getEvent(db, eventId);
  if (!event) return res.status(404).json({ error: 'Événement introuvable' });
  if (req.user.role !== 'superuser') {
    const membership = getEventUser(db, { event_id: eventId, user_id: req.user.sub });
    if (!membership) return res.status(403).json({ error: 'Accès interdit' });
  }
  req.event = event;
  next();
}
