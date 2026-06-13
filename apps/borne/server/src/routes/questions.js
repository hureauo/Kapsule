import { Router } from 'express';
import { validateQuestion } from '@kapsule/core';
import { getActiveEvent } from '../registry.js';
import { getActiveEventDb } from '../eventDb.js';

export function makeQuestionsRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireAdmin;

  function requireActiveDb(req, res) {
    const active = getActiveEvent();
    if (!active) {
      res.status(404).json({ error: 'Aucun événement actif' });
      return null;
    }
    return getActiveEventDb(dataDir, active);
  }

  // ── Route publique ────────────────────────────────────────────────────────

  router.get('/questions', (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const questions = db
        .prepare('SELECT * FROM questions WHERE enabled=1 ORDER BY order_index, id')
        .all();
      res.json(questions);
    } catch (err) {
      next(err);
    }
  });

  // ── Routes admin ──────────────────────────────────────────────────────────

  // IMPORTANT : routes à segment fixe (/all, /reorder/batch) déclarées AVANT /:id
  // (invariant §11.1 — sinon Express interprète le segment comme un :id)
  router.get('/questions/all', auth, (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const questions = db
        .prepare('SELECT * FROM questions ORDER BY order_index, id')
        .all();
      res.json(questions);
    } catch (err) {
      next(err);
    }
  });

  router.put('/questions/reorder/batch', auth, (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const { order } = req.body;
      if (!Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ error: 'order doit être un tableau non vide' });
      }
      const update = db.prepare(
        'UPDATE questions SET order_index=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      );
      db.transaction(() => {
        for (const { id, order_index } of order) {
          update.run(order_index, id);
        }
      })();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/questions', auth, (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const { text, max_duration = 60, countdown = 3 } = req.body;
      const err = validateQuestion({ text, max_duration, countdown });
      if (err) return res.status(400).json({ error: err });
      const maxRow = db.prepare('SELECT MAX(order_index) as m FROM questions').get();
      const order_index = (maxRow.m ?? -1) + 1;
      const result = db.prepare(
        'INSERT INTO questions (text, max_duration, countdown, order_index) VALUES (?, ?, ?, ?)'
      ).run(text.trim(), max_duration, countdown, order_index);
      const question = db.prepare('SELECT * FROM questions WHERE id=?').get(result.lastInsertRowid);
      res.status(201).json(question);
    } catch (err) {
      next(err);
    }
  });

  router.put('/questions/:id', auth, (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const { id } = req.params;
      const question = db.prepare('SELECT * FROM questions WHERE id=?').get(id);
      if (!question) return res.status(404).json({ error: 'Question introuvable' });

      const { text, max_duration, countdown, enabled, order_index } = req.body;
      // Validation uniquement sur les champs fournis
      if (text !== undefined || max_duration !== undefined || countdown !== undefined) {
        const toValidate = {
          text: text ?? question.text,
          max_duration: max_duration ?? question.max_duration,
          countdown: countdown ?? question.countdown,
        };
        const err = validateQuestion(toValidate);
        if (err) return res.status(400).json({ error: err });
      }

      const fields = [];
      const values = [];
      if (text !== undefined)        { fields.push('text=?');         values.push(text.trim()); }
      if (max_duration !== undefined){ fields.push('max_duration=?'); values.push(max_duration); }
      if (countdown !== undefined)   { fields.push('countdown=?');    values.push(countdown); }
      if (enabled !== undefined)     { fields.push('enabled=?');      values.push(enabled ? 1 : 0); }
      if (order_index !== undefined) { fields.push('order_index=?');  values.push(order_index); }

      if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });

      fields.push('updated_at=CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id=?`).run(...values);
      res.json(db.prepare('SELECT * FROM questions WHERE id=?').get(id));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/questions/:id', auth, (req, res, next) => {
    try {
      const db = requireActiveDb(req, res);
      if (!db) return;
      const { id } = req.params;
      const question = db.prepare('SELECT * FROM questions WHERE id=?').get(id);
      if (!question) return res.status(404).json({ error: 'Question introuvable' });
      db.prepare('DELETE FROM questions WHERE id=?').run(id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
