import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import { DEFAULTS } from '@kapsule/core';

function QuestionForm({ onSave, initial = null, onCancel }) {
  const [text, setText] = useState(initial?.text ?? '');
  const [max_duration, setMaxDuration] = useState(initial?.max_duration ?? DEFAULTS.MAX_DURATION_S);
  const [countdown, setCountdown] = useState(initial?.countdown ?? DEFAULTS.COUNTDOWN_S);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await onSave({ text, max_duration, countdown });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <form className="question-form" onSubmit={handleSubmit}>
      <textarea
        className="hub-input"
        rows={3}
        placeholder="Texte de la question"
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />
      <div className="question-form__row">
        <label className="field-label field-label--inline">
          Durée max (s)
          <input
            type="number"
            className="hub-input hub-input--sm"
            min={10}
            max={300}
            value={max_duration}
            onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setMaxDuration(v); }}
          />
        </label>
        <label className="field-label field-label--inline">
          Compte à rebours (s)
          <input
            type="number"
            className="hub-input hub-input--sm"
            min={0}
            max={10}
            value={countdown}
            onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setCountdown(v); }}
          />
        </label>
      </div>
      {error && <p className="error-msg">{error}</p>}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn btn--ghost" onClick={onCancel}>Annuler</button>}
        <button type="submit" className="btn btn--primary">
          {initial ? 'Enregistrer' : 'Ajouter'}
        </button>
      </div>
    </form>
  );
}

export default function QuestionEditor({ eventId, frozen }) {
  const [questions, setQuestions] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const dragItem = useRef(null);

  async function load() {
    try {
      setQuestions(await api.listQuestions(eventId));
    } catch {}
  }

  useEffect(() => { load(); }, [eventId]);

  async function handleAdd(fields) {
    await api.createQuestion(eventId, fields);
    await load();
  }

  async function handleEdit(id, fields) {
    await api.updateQuestion(eventId, id, fields);
    setEditingId(null);
    await load();
  }

  async function handleDelete(id) {
    await api.deleteQuestion(eventId, id);
    setDeleteId(null);
    await load();
  }

  function onDragStart(index) { dragItem.current = index; }

  function onDragEnter(index) {
    if (dragItem.current === null || dragItem.current === index) return;
    setQuestions((qs) => {
      const copy = [...qs];
      const [dragged] = copy.splice(dragItem.current, 1);
      copy.splice(index, 0, dragged);
      dragItem.current = index;
      return copy;
    });
  }

  async function onDragEnd() {
    const order = questions.map((q, i) => ({ id: q.id, order_index: i }));
    try {
      await api.reorderQuestions(eventId, order);
    } catch {
      await load();
    }
    dragItem.current = null;
  }

  return (
    <div className="question-editor">
      {questions.length === 0 ? (
        <p className="text--muted">Aucune question.</p>
      ) : (
        <ul className="question-list">
          {questions.map((q, i) => (
            <li
              key={q.id}
              className="question-row"
              draggable={!frozen}
              onDragStart={() => onDragStart(i)}
              onDragEnter={() => onDragEnter(i)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => e.preventDefault()}
            >
              {editingId === q.id ? (
                <QuestionForm
                  initial={q}
                  onSave={(f) => handleEdit(q.id, f)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="question-row__content">
                  <span className="question-row__drag" aria-hidden>⠿</span>
                  <div className="question-row__text">
                    <p>{q.text}</p>
                    <small className="text--muted">{q.max_duration}s · compte {q.countdown}s</small>
                  </div>
                  {!frozen && (
                    <div className="question-row__actions">
                      <button className="btn btn--ghost btn--sm" onClick={() => setEditingId(q.id)}>
                        Éditer
                      </button>
                      <button className="btn btn--danger btn--sm" onClick={() => setDeleteId(q.id)}>
                        Suppr.
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!frozen && (
        <div className="question-editor__add">
          <h4 className="form-title">Ajouter une question</h4>
          <QuestionForm onSave={handleAdd} />
        </div>
      )}

      {deleteId && (
        <div className="modal-overlay" onClick={() => setDeleteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p>Supprimer cette question ?</p>
            <p className="text--muted">
              Les vidéos déjà enregistrées conserveront le texte de la question.
            </p>
            <div className="form-actions">
              <button className="btn btn--ghost" onClick={() => setDeleteId(null)}>Annuler</button>
              <button className="btn btn--danger" onClick={() => handleDelete(deleteId)}>Supprimer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
