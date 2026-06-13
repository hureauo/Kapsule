import { Router } from 'express';
import { validateQuestion } from '@kapsule/core';
import { getDb, getEvent } from '../registry.js';
import { openEventDb } from '../eventStore.js';
import { requireUser, requireOwner } from '../middleware/auth.js';

const FROZEN_STATUSES = new Set(['live', 'closed', 'pushed', 'processed', 'purged']);

// Monté sous /api/events/:eventId/questions (avec mergeParams: true)
export function makeQuestionsRouter(dataDir) {
  const router = Router({ mergeParams: true });

  function getEventDb(req) {
    return openEventDb(req.params.eventId, dataDir);
  }

  function checkFrozen(req, res) {
    // requireOwner a déjà posé req.event; sinon relire depuis le registre
    const event = req.event ?? getEvent(getDb(), req.params.eventId);
    if (event && FROZEN_STATUSES.has(event.status)) {
      res.status(409).json({ error: `Édition impossible : événement en statut ${event.status}` });
      return true;
    }
    return false;
  }

  // ── GET /api/events/:eventId/questions ──────────────────────────────────
  // Déclarée avant /reorder/batch et /:id (invariant §11.1 non concerné ici
  // car pas de segment "export" — mais on respecte l'ordre par précaution)
  router.get('/', requireUser, requireOwner, (req, res, next) => {
    try {
      const db = getEventDb(req);
      const questions = db
        .prepare('SELECT * FROM questions ORDER BY order_index, id')
        .all();
      res.json(questions);
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/events/:eventId/questions/reorder/batch ─────────────────────
  // Déclarée AVANT /:id (sinon Express interprète "reorder" comme un id)
  router.put('/reorder/batch', requireUser, requireOwner, (req, res, next) => {
    try {
      if (checkFrozen(req, res)) return;
      const db = getEventDb(req);
      const { order } = req.body;
      if (!Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ error: 'order doit être un tableau non vide' });
      }
      const update = db.prepare(
        'UPDATE questions SET order_index=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      );
      db.transaction(() => {
        for (const { id, order_index } of order) update.run(order_index, id);
      })();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/events/:eventId/questions ──────────────────────────────────
  router.post('/', requireUser, requireOwner, (req, res, next) => {
    try {
      if (checkFrozen(req, res)) return;
      const db = getEventDb(req);
      const { text, max_duration = 60, countdown = 3 } = req.body;
      const err = validateQuestion({ text, max_duration, countdown });
      if (err) return res.status(400).json({ error: err });

      const maxRow = db.prepare('SELECT MAX(order_index) as m FROM questions').get();
      const order_index = (maxRow.m ?? -1) + 1;
      const result = db
        .prepare('INSERT INTO questions (text, max_duration, countdown, order_index) VALUES (?, ?, ?, ?)')
        .run(text.trim(), max_duration, countdown, order_index);
      res.status(201).json(db.prepare('SELECT * FROM questions WHERE id=?').get(result.lastInsertRowid));
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/events/:eventId/questions/:id ────────────────────────────────
  router.put('/:id', requireUser, requireOwner, (req, res, next) => {
    try {
      if (checkFrozen(req, res)) return;
      const db = getEventDb(req);
      const question = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);
      if (!question) return res.status(404).json({ error: 'Question introuvable' });

      const { text, max_duration, countdown, enabled, order_index } = req.body;
      if (text !== undefined || max_duration !== undefined || countdown !== undefined) {
        const err = validateQuestion({
          text: text ?? question.text,
          max_duration: max_duration ?? question.max_duration,
          countdown: countdown ?? question.countdown,
        });
        if (err) return res.status(400).json({ error: err });
      }

      const fields = [];
      const values = [];
      if (text !== undefined)         { fields.push('text=?');         values.push(text.trim()); }
      if (max_duration !== undefined) { fields.push('max_duration=?'); values.push(max_duration); }
      if (countdown !== undefined)    { fields.push('countdown=?');    values.push(countdown); }
      if (enabled !== undefined)      { fields.push('enabled=?');      values.push(enabled ? 1 : 0); }
      if (order_index !== undefined)  { fields.push('order_index=?');  values.push(order_index); }
      if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });

      fields.push('updated_at=CURRENT_TIMESTAMP');
      values.push(req.params.id);
      db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id=?`).run(...values);
      res.json(db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/events/:eventId/questions/:id ─────────────────────────────
  router.delete('/:id', requireUser, requireOwner, (req, res, next) => {
    try {
      if (checkFrozen(req, res)) return;
      const db = getEventDb(req);
      const question = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);
      if (!question) return res.status(404).json({ error: 'Question introuvable' });
      db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
