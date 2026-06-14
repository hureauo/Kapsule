import { createHash } from 'node:crypto';
import { getDb, getBoxByTokenHash, updateBoxSeen, insertSyncLog } from '../registry.js';

export function requireBox(req, res, next) {
  const raw = req.headers['x-box-token'];
  if (!raw) return res.status(401).json({ error: 'X-Box-Token manquant' });

  const hash = createHash('sha256').update(raw).digest('hex');
  const db = getDb();
  const box = getBoxByTokenHash(db, hash);
  if (!box) return res.status(401).json({ error: 'Token borne invalide' });

  updateBoxSeen(db, box.id);
  insertSyncLog(db, { box_id: box.id, action: req._syncLogAction ?? 'heartbeat', detail: null });

  req.box = box;
  next();
}
