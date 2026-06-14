import { Router } from 'express';
import { getDb, getEvent, updateEvent, insertSyncLog } from '../registry.js';
import { openEventDb } from '../eventStore.js';
import { requireBox } from '../middleware/boxAuth.js';

// Ordre des statuts pour les transitions avant uniquement (heartbeat)
const STATUS_ORDER = ['draft', 'ready', 'loaded', 'live', 'closed', 'pushed', 'processed', 'purged'];

function statusRank(s) {
  const i = STATUS_ORDER.indexOf(s);
  return i === -1 ? -1 : i;
}

export function makeSyncRouter(dataDir) {
  const router = Router();
  router.use(requireBox);

  // ── GET /api/sync/assigned ────────────────────────────────────────────────
  // Événements status IN ('ready','loaded') assignés à cette borne
  router.get('/assigned', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, name, event_date, status, updated_at
      FROM events
      WHERE box_id = ? AND status IN ('ready','loaded')
      ORDER BY updated_at DESC
    `).all(req.box.id);
    res.json(rows);
  });

  // ── GET /api/sync/events/:id/bundle ──────────────────────────────────────
  // Retourne { event, questions } ; passe ready→loaded, set pulled_at
  router.get('/events/:id/bundle', (req, res, next) => {
    try {
      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (event.box_id !== req.box.id) return res.status(403).json({ error: 'Non assigné à cette borne' });
      if (!['ready', 'loaded'].includes(event.status)) {
        return res.status(409).json({ error: `Statut ${event.status} — bundle non disponible` });
      }

      // Transition ready→loaded + pulled_at
      if (event.status === 'ready') {
        updateEvent(db, event.id, { status: 'loaded', pulled_at: new Date().toISOString() });
        insertSyncLog(db, { event_id: event.id, box_id: req.box.id, action: 'pull', detail: { from: 'ready', to: 'loaded' } });
      }

      // Lire les questions depuis la BD événement
      const edb = openEventDb(event.id, dataDir);
      const questions = edb.prepare(
        'SELECT id, text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index ASC'
      ).all();

      // Lire event_meta (consent_text, idle_timeout)
      const metaRows = edb.prepare('SELECT key, value FROM event_meta').all();
      const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

      const freshEvent = getEvent(db, event.id);
      res.json({ event: { ...freshEvent, meta }, questions });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/events/:id/status ─────────────────────────────────────
  // Heartbeat best effort : transitions avant uniquement (live|closed)
  router.post('/events/:id/status', (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['live', 'closed'].includes(status)) {
        return res.status(400).json({ error: 'status doit être live ou closed' });
      }

      const db = getDb();
      const event = getEvent(db, req.params.id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });
      if (event.box_id !== req.box.id) return res.status(403).json({ error: 'Non assigné à cette borne' });

      // Transition avant uniquement
      if (statusRank(status) <= statusRank(event.status)) {
        return res.status(409).json({ error: `Transition ${event.status}→${status} non autorisée (retour en arrière)` });
      }

      updateEvent(db, event.id, { status });
      insertSyncLog(db, { event_id: event.id, box_id: req.box.id, action: 'status', detail: { from: event.status, to: status } });

      res.json({ ok: true, status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
