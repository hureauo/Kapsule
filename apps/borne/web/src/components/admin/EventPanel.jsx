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

// Console /borne (Phase B — auth tech, cf. §11.19). Regroupe le cycle de vie
// complet d'un événement local : activer, clôturer, purger. Toutes les
// requêtes passent par le tech_token (api.tech*) — /borne n'a jamais
// admin_token en mémoire.
export default function EventPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Purge (déplacée depuis SyncPanel — regroupée avec le reste du cycle de vie)
  const [purgeEventId, setPurgeEventId] = useState(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purgeMsg, setPurgeMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setEvents(await api.techListEvents());
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
      await api.techActivateEvent(id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleClose(id) {
    try {
      await api.closeEvent(id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handlePurge(e) {
    e.preventDefault();
    const ev = events.find((ev) => ev.id === purgeEventId);
    if (!ev) return;
    setPurgeMsg('');
    try {
      await api.purgeEvent(purgeEventId, purgeConfirm);
      setPurgeEventId(null);
      setPurgeConfirm('');
      setPurgeMsg('Événement purgé.');
      await load();
    } catch (err) {
      setPurgeMsg(`Erreur : ${err.message}`);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;
  if (error) return (
    <p className="text--error">
      {error}{' '}
      <button className="btn btn--small btn--secondary" onClick={load}>Réessayer</button>
    </p>
  );

  return (
    <div className="event-panel">
      <section className="panel-section">
        <h2 className="panel-section__title">Événement actif</h2>
        {active ? (
          <div className="event-card event-card--active">
            <div className="event-card__name">{active.name}</div>
            <StatusBadge status={active.status} />
          </div>
        ) : (
          <p className="text--muted">Aucun événement actif.</p>
        )}
      </section>

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
                    {ev.status === 'live' && (
                      <button className="btn btn--small btn--secondary" onClick={() => handleClose(ev.id)}>
                        Clôturer
                      </button>
                    )}
                    {ev.status === 'pushed' && purgeEventId !== ev.id && (
                      <button
                        className="btn btn--small btn--danger"
                        onClick={() => { setPurgeEventId(ev.id); setPurgeConfirm(''); setPurgeMsg(''); }}
                      >
                        Purger
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {purgeEventId !== null && (
        <section className="panel-section">
          <h2 className="panel-section__title">Confirmer la purge</h2>
          <form onSubmit={handlePurge} className="purge-form">
            <p className="text--warn">
              Cette action supprime définitivement tous les fichiers locaux de l'événement
              « {events.find((ev) => ev.id === purgeEventId)?.name} ».
            </p>
            <label className="field-label">
              Saisir le nom de l'événement pour confirmer
              <input
                className="admin-input"
                type="text"
                value={purgeConfirm}
                onChange={(e) => setPurgeConfirm(e.target.value)}
                autoFocus
              />
            </label>
            {purgeMsg && <p className="error-msg">{purgeMsg}</p>}
            <div className="purge-form__actions">
              <button type="submit" className="btn btn--danger">Confirmer la purge</button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => { setPurgeEventId(null); setPurgeMsg(''); }}
              >
                Annuler
              </button>
            </div>
          </form>
        </section>
      )}
      {purgeMsg && purgeEventId === null && <p className="text--muted">{purgeMsg}</p>}
    </div>
  );
}
