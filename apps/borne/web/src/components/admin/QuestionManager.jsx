import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

const DEFAULT_FORM = { text: '', max_duration: 60, countdown: 3 };

function QuestionForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial ?? DEFAULT_FORM);

  function set(key, val) { setForm((f) => ({ ...f, [key]: val })); }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.text.trim()) return;
    onSave({ ...form, text: form.text.trim() });
  }

  return (
    <form className="question-form" onSubmit={handleSubmit}>
      <input
        className="admin-input question-form__text"
        type="text"
        placeholder="Texte de la question"
        value={form.text}
        onChange={(e) => set('text', e.target.value)}
        required
        disabled={saving}
      />
      <label className="question-form__field">
        <span>Durée max (s)</span>
        <input
          className="admin-input question-form__num"
          type="number"
          min="10" max="300"
          value={form.max_duration}
          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) set('max_duration', v); }}
          disabled={saving}
        />
      </label>
      <label className="question-form__field">
        <span>Compte à rebours (s)</span>
        <input
          className="admin-input question-form__num"
          type="number"
          min="0" max="10"
          value={form.countdown}
          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) set('countdown', v); }}
          disabled={saving}
        />
      </label>
      <div className="question-form__actions">
        <button className="btn btn--small btn--primary" type="submit" disabled={saving || !form.text.trim()}>
          {saving ? 'Enregistrement…' : (initial ? 'Mettre à jour' : 'Ajouter')}
        </button>
        {onCancel && (
          <button className="btn btn--small btn--secondary" type="button" onClick={onCancel} disabled={saving}>
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}

export default function QuestionManager() {
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  // Édition inline
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving]       = useState(false);

  // Suppression avec confirmation
  const [deletingId, setDeletingId] = useState(null);

  // Drag-to-reorder HTML5 natif
  const dragItem = useRef(null);
  const dragOver = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.listAllQuestions();
      setQuestions(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(data) {
    setSaving(true);
    try {
      await api.createQuestion(data);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id, data) {
    setSaving(true);
    try {
      await api.updateQuestion(id, data);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(q) {
    try {
      await api.updateQuestion(q.id, { enabled: q.enabled ? 0 : 1 });
      // Mise à jour optimiste
      setQuestions((qs) => qs.map((x) => x.id === q.id ? { ...x, enabled: x.enabled ? 0 : 1 } : x));
    } catch (e) {
      setError(e.message);
      await load(); // rollback
    }
  }

  async function handleDelete(id) {
    try {
      await api.deleteQuestion(id);
      setDeletingId(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  // ── Drag-to-reorder ────────────────────────────────────────────────────────
  function onDragStart(index) {
    dragItem.current = index;
  }

  function onDragEnter(index) {
    if (dragItem.current === null || dragItem.current === index) return;
    dragOver.current = index;
    setQuestions((qs) => {
      const copy = [...qs];
      const [dragged] = copy.splice(dragItem.current, 1);
      copy.splice(index, 0, dragged);
      dragItem.current = index;
      return copy;
    });
  }

  async function onDragEnd() {
    dragItem.current = null;
    dragOver.current = null;
    // Persistance de l'ordre
    const order = questions.map((q, i) => ({ id: q.id, order_index: i }));
    try {
      await api.reorderQuestions(order);
    } catch (e) {
      setError(e.message);
      await load(); // rollback si erreur
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <div className="question-manager">
      {error && <p className="text--error">{error}</p>}

      {/* Formulaire d'ajout */}
      <section className="panel-section">
        <h2 className="panel-section__title">Ajouter une question</h2>
        <QuestionForm onSave={handleAdd} saving={saving} />
      </section>

      {/* Table des questions */}
      <section className="panel-section">
        <h2 className="panel-section__title">
          Questions ({questions.length})
          <span className="panel-section__hint"> — glisser pour réordonner</span>
        </h2>

        {questions.length === 0 ? (
          <p className="text--muted">Aucune question. Ajoutez-en une ci-dessus.</p>
        ) : (
          <div className="question-list">
            {questions.map((q, i) => (
              <div
                key={q.id}
                className={`question-row${q.enabled ? '' : ' question-row--disabled'}`}
                draggable
                onDragStart={() => onDragStart(i)}
                onDragEnter={() => onDragEnter(i)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => e.preventDefault()}
              >
                {editingId === q.id ? (
                  <QuestionForm
                    initial={{ text: q.text, max_duration: q.max_duration, countdown: q.countdown }}
                    onSave={(data) => handleUpdate(q.id, data)}
                    onCancel={() => setEditingId(null)}
                    saving={saving}
                  />
                ) : (
                  <>
                    <span className="question-row__handle" title="Glisser pour réordonner">⠿</span>
                    <span className={`question-row__index${q.enabled ? '' : ' question-row__index--off'}`}>
                      {i + 1}
                    </span>
                    <div className="question-row__body">
                      <span className="question-row__text">{q.text}</span>
                      <span className="question-row__meta">
                        {q.max_duration}s · compte à rebours {q.countdown}s
                        {!q.enabled && <em> · désactivée</em>}
                      </span>
                    </div>
                    <div className="question-row__actions">
                      <button
                        className="btn btn--small btn--secondary"
                        onClick={() => handleToggle(q)}
                        title={q.enabled ? 'Désactiver' : 'Activer'}
                      >
                        {q.enabled ? 'Désactiver' : 'Activer'}
                      </button>
                      <button
                        className="btn btn--small btn--secondary"
                        onClick={() => setEditingId(q.id)}
                      >
                        Modifier
                      </button>
                      <button
                        className="btn btn--small btn--danger"
                        onClick={() => setDeletingId(q.id)}
                      >
                        Supprimer
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Confirmation de suppression */}
      {deletingId && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 className="modal__title">Supprimer la question ?</h3>
            <p className="text--muted">
              Les vidéos déjà enregistrées conserveront le texte de la question (dénormalisé en base).
              Cette action est irréversible.
            </p>
            <div className="modal__actions">
              <button className="btn btn--small btn--secondary" onClick={() => setDeletingId(null)}>
                Annuler
              </button>
              <button className="btn btn--small btn--danger" onClick={() => handleDelete(deletingId)}>
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
