import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken, getRole } from '../api/client.js';

const STATUS_LABEL = {
  draft: 'Brouillon', preview: 'Preview', ready: 'Prêt', loaded: 'Chargé',
  live: 'En cours', closed: 'Terminé', pushed: 'Poussé',
  processed: 'Traité', waiting: 'En attente',
};

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR');
}

export default function EventsPage() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDate, setNewDate] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const isSuperuser = getRole() === 'superuser';

  async function load() {
    try {
      setEvents(await api.listEvents());
    } catch (err) {
      if (err.status === 401) { clearToken(); navigate('/login', { replace: true }); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const ev = await api.createEvent(newName.trim(), newDate || null);
      navigate(`/events/${ev.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function handleLogout() {
    clearToken();
    navigate('/login', { replace: true });
  }

  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="hub-logo">Kapsule Hub</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {isSuperuser && (
            <button className="btn btn--ghost" onClick={() => navigate('/admin')}>Administration</button>
          )}
          <button className="btn btn--ghost" onClick={handleLogout}>Déconnexion</button>
        </div>
      </header>

      <main className="hub-main">
        <div className="section-header">
          <h2 className="section-title">Événements</h2>
          {isSuperuser && (
            <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
              + Nouvel événement
            </button>
          )}
        </div>

        {error && <p className="error-msg">{error}</p>}

        {isSuperuser && showCreate && (
          <form className="create-form" onSubmit={handleCreate}>
            <h3 className="form-title">Nouvel événement</h3>
            <label className="field-label">
              Nom
              <input
                className="hub-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="field-label">
              Date (optionnel)
              <input
                type="date"
                className="hub-input"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setShowCreate(false)}>
                Annuler
              </button>
              <button type="submit" className="btn btn--primary" disabled={creating}>
                {creating ? 'Création…' : 'Créer'}
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text--muted">Chargement…</p>
        ) : events.length === 0 ? (
          <p className="text--muted">
            {isSuperuser ? 'Aucun événement. Créez-en un !' : 'Aucun événement ne vous a encore été assigné.'}
          </p>
        ) : (
          <table className="hub-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Date</th>
                <th>Statut</th>
                <th>Borne</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr
                  key={ev.id}
                  className="hub-table__row--clickable"
                  onClick={() => navigate(`/events/${ev.id}`)}
                >
                  <td>{ev.name}</td>
                  <td>{formatDate(ev.event_date)}</td>
                  <td>
                    <span className={`status-badge status-badge--${ev.status}`}>
                      {STATUS_LABEL[ev.status] ?? ev.status}
                    </span>
                  </td>
                  <td>{ev.box_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
