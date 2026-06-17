import { createHash } from 'node:crypto';
import { getDb, getBoxTokenByHash, updateBoxTokenSeen } from '../registry.js';

export function requireBox(req, res, next) {
  const raw = req.headers['x-box-token'];
  if (!raw) return res.status(401).json({ error: 'X-Box-Token manquant' });

  const hash = createHash('sha256').update(raw).digest('hex');
  const db = getDb();
  const row = getBoxTokenByHash(db, hash);
  if (!row) return res.status(401).json({ error: 'Token borne invalide' });

  updateBoxTokenSeen(db, row.id);
  // Exposer token_id, event_id et is_preview (invariant §11.20)
  req.box = { token_id: row.id, event_id: row.event_id, is_preview: row.is_preview };
  next();
}
