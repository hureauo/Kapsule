import { Router } from 'express';
import { requireUser, requireOwner } from '../middleware/auth.js';
import { getDb, listEventVersions, getEventVersion, getPreviousEventVersion } from '../registry.js';
import { openEventDb } from '../eventStore.js';
import { applyEventConfig } from '../eventConfig.js';
import { captureSnapshot, resolveAuthor } from '../versioning.js';
import { restoreEventDesign } from './events.js';

// Monté sous /api/events/:eventId/versions (mergeParams: true)
export function makeVersionsRouter(dataDir) {
  const router = Router({ mergeParams: true });

  // ── GET /api/events/:eventId/versions ─────────────────────────────────────
  // Liste toutes les versions (sans snapshot) — membres + superusers
  router.get('/', requireUser, requireOwner, (req, res) => {
    const db = getDb();
    const versions = listEventVersions(db, req.event.id);
    res.json(versions);
  });

  // ── GET /api/events/:eventId/versions/:versionId ──────────────────────────
  // Snapshot complet + diff champ par champ vs version précédente
  router.get('/:versionId', requireUser, requireOwner, (req, res) => {
    const db = getDb();
    const version = getEventVersion(db, req.params.versionId);
    if (!version || version.event_id !== req.event.id) {
      return res.status(404).json({ error: 'Version introuvable' });
    }

    const prevRow = getPreviousEventVersion(db, req.event.id, version.id);
    const prev = prevRow ? prevRow.snapshot : null;

    res.json({ ...version, diff: buildDiff(prev, version.snapshot) });
  });

  // ── POST /api/events/:eventId/versions/:versionId/restore ─────────────────
  // Réapplique le snapshot — superuser seulement
  router.post('/:versionId/restore', requireUser, requireOwner, (req, res, next) => {
    if (req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Réservé aux admins' });
    }
    try {
      const db = getDb();
      const version = getEventVersion(db, req.params.versionId);
      if (!version || version.event_id !== req.event.id) {
        return res.status(404).json({ error: 'Version introuvable' });
      }

      const edb = openEventDb(req.event.id, dataDir);
      applyEventConfig(edb, { mode: 'overwrite', ...version.snapshot });
      // `design` n'est pas dans META_KEYS (donc applyEventConfig l'ignore) : on
      // le restaure séparément pour que l'historique dise vrai (§9bis).
      restoreEventDesign(dataDir, req.event.id, edb, version.snapshot);

      // Capture un snapshot de restauration
      const author = resolveAuthor(db, req.user);
      captureSnapshot(db, edb, {
        event_id: req.event.id,
        author,
        summaryOverride: `Restauration vers version du ${version.created_at.slice(0, 16).replace('T', ' ')}`,
      });

      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

// Calcule un diff lisible entre deux snapshots.
function buildDiff(prev, next) {
  const changes = [];

  // Questions
  const qPrev = prev?.questions ?? [];
  const qNext = next.questions ?? [];
  const added   = qNext.filter(q => !qPrev.some(p => p.text === q.text));
  const removed = qPrev.filter(p => !qNext.some(q => q.text === p.text));
  const reordered =
    qPrev.length === qNext.length &&
    added.length === 0 &&
    removed.length === 0 &&
    JSON.stringify(qPrev.map(q => q.text)) !== JSON.stringify(qNext.map(q => q.text));

  if (added.length)    changes.push({ type: 'questions_added',   items: added.map(q => q.text) });
  if (removed.length)  changes.push({ type: 'questions_removed', items: removed.map(q => q.text) });
  if (reordered)       changes.push({ type: 'questions_reordered' });

  const modifiedQ = qNext.filter(q => {
    const p = qPrev.find(p => p.text === q.text);
    return p && JSON.stringify(p) !== JSON.stringify(q);
  });
  if (modifiedQ.length) changes.push({ type: 'questions_modified', items: modifiedQ.map(q => q.text) });

  // Meta
  const allKeys = new Set([...Object.keys(prev?.meta ?? {}), ...Object.keys(next.meta ?? {})]);
  for (const key of allKeys) {
    const before = prev?.meta?.[key] ?? null;
    const after  = next.meta?.[key] ?? null;
    if (before !== after) changes.push({ type: 'meta_changed', key, before, after });
  }

  return changes;
}
