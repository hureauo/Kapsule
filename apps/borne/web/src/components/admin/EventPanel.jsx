import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';

const STATUS_LABEL = {
  loaded: 'Chargé',
  live:   'En cours',
  closed: 'Clôturé',
  pushed: 'Poussé',
  purged: 'Purgé',
};

function StatusBadge({ status }) {
  return (
    <span className={`event-badge event-badge--${status}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function EventPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Création
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Clôture
  const [closingId, setClosingId] = useState(null);
  const [confirmName, setConfirmName] = useState('');
  const [closeError, setCloseError] = useState('');
  const [closing, setClosing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setEvents(await api.listEvents());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = events.find((e) => e.active);

  async function handleActivate(id) {
    try {
      await api.activateEvent(id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.createEvent({ name });
      setNewName('');
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function openClose(event) {
    setClosingId(event.id);
    setConfirmName('');
    setCloseError('');
  }

  async function handleClose() {
    const event = events.find((e) => e.id === closingId);
    if (!event || confirmName.trim() !== event.name.trim()) {
      setCloseError('Le nom saisi ne correspond pas.');
      return;
    }
    setClosing(true);
    setCloseError('');
    try {
      await api.closeEvent(closingId);
      setClosingId(null);
      await load();
    } catch (err) {
      setCloseError(err.message);
    } finally {
      setClosing(false);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;
  if (error)   return <p className="text--error">{error} <button className="btn btn--small btn--secondary" onClick={load}>Réessayer</button></p>;

  const closingEvent = events.find((e) => e.id === closingId);

  return (
    <div className="event-panel">

      {/* Événement actif */}
      <section className="panel-section">
        <h2 className="panel-section__title">Événement actif</h2>
        {active ? (
          <div className="event-card event-card--active">
            <div className="event-card__name">{active.name}</div>
            <StatusBadge status={active.status} />
            {active.status === 'live' && (
              <button className="btn btn--small btn--danger" onClick={() => openClose(active)}>
                Clôturer l'événement
              </button>
            )}
          </div>
        ) : (
          <p className="text--muted">Aucun événement actif.</p>
        )}
      </section>

      {/* Tous les événements */}
      <section className="panel-section">
        <h2 className="panel-section__title">Tous les événements</h2>
        {events.length === 0 ? (
          <p className="text--muted">Aucun événement créé.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Statut</th>
                <th>Actif</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className={ev.active ? 'admin-table__row--active' : ''}>
                  <td>{ev.name}</td>
                  <td><StatusBadge status={ev.status} /></td>
                  <td>{ev.active ? '●' : ''}</td>
                  <td>
                    {!ev.active && !['pushed', 'purged'].includes(ev.status) && (
                      <button className="btn btn--small btn--secondary" onClick={() => handleActivate(ev.id)}>
                        Activer
                      </button>
                    )}
                    {ev.active && ev.status === 'live' && (
                      <button className="btn btn--small btn--danger" onClick={() => openClose(ev)}>
                        Clôturer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Création d'un événement local */}
      <section className="panel-section">
        <h2 className="panel-section__title">Créer un événement local</h2>
        <form className="inline-form" onSubmit={handleCreate}>
          <input
            className="admin-input"
            type="text"
            placeholder="Nom de l'événement"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setCreateError(''); }}
            disabled={creating}
          />
          <button className="btn btn--small btn--primary" type="submit" disabled={creating || !newName.trim()}>
            {creating ? 'Création…' : 'Créer'}
          </button>
        </form>
        {createError && <p className="text--error">{createError}</p>}
      </section>

      {/* Modal de confirmation de clôture */}
      {closingId && closingEvent && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 className="modal__title">Clôturer l'événement</h3>
            <p className="text--muted">
              Le kiosque passera en mode « événement terminé ». Pour confirmer, saisissez le nom de l'événement&nbsp;:
              <strong> {closingEvent.name}</strong>
            </p>
            <input
              className="admin-input"
              type="text"
              autoFocus
              placeholder={closingEvent.name}
              value={confirmName}
              onChange={(e) => { setConfirmName(e.target.value); setCloseError(''); }}
              disabled={closing}
            />
            {closeError && <p className="text--error">{closeError}</p>}
            <div className="modal__actions">
              <button className="btn btn--small btn--secondary" onClick={() => setClosingId(null)} disabled={closing}>
                Annuler
              </button>
              <button className="btn btn--small btn--danger" onClick={handleClose} disabled={closing || !confirmName.trim()}>
                {closing ? 'Clôture…' : 'Confirmer la clôture'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
