import { createHash } from 'node:crypto';
import { getDb, getBoxTokenByHash, updateBoxTokenSeen, getBorneByHash, listBorneEvents } from '../registry.js';

// Résout le header X-Box-Token contre les DEUX tables possibles :
// - box_tokens : token = événement (bornes d'essai, provisioner Hub inchangé)
// - bornes     : token = machine physique (Phase B), plusieurs événements assignés
//
// req.box normalisé selon la source :
//   { kind: 'preview', token_id, event_id, is_preview }
//   { kind: 'borne',   borne_id, event_ids: [...] }
export function requireBox(req, res, next) {
  const raw = req.headers['x-box-token'];
  if (!raw) return res.status(401).json({ error: 'X-Box-Token manquant' });

  const hash = createHash('sha256').update(raw).digest('hex');
  const db = getDb();

  const boxToken = getBoxTokenByHash(db, hash);
  if (boxToken) {
    updateBoxTokenSeen(db, boxToken.id);
    req.box = { kind: 'preview', token_id: boxToken.id, event_id: boxToken.event_id, is_preview: boxToken.is_preview };
    return next();
  }

  const borne = getBorneByHash(db, hash);
  if (borne) {
    if (!borne.active) return res.status(401).json({ error: 'Borne désactivée' });
    req.box = { kind: 'borne', borne_id: borne.id, event_ids: listBorneEvents(db, borne.id).map((e) => e.id) };
    return next();
  }

  return res.status(401).json({ error: 'Token borne invalide' });
}

// Invariant §11.20 (réécrit Phase B) : un token preview ne touche que son propre
// événement ; un token borne ne touche que les événements qui LUI sont assignés.
// Point de contrôle unique — appelé explicitement à l'endroit exact de l'ancien
// `req.params.id !== req.box.event_id` pour préserver l'ordre existence→scope
// de chaque route (pas un middleware générique : les messages d'erreur et
// l'ordre des vérifications restent portés par chaque handler).
export function boxHasEventAccess(box, eventId) {
  return box.kind === 'borne' ? box.event_ids.includes(eventId) : box.event_id === eventId;
}
