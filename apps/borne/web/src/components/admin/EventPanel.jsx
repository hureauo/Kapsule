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

// La clôture d'un événement est une action technicien (requireTech) — elle
// n'apparaît pas dans le panneau client. Le technicien l'effectue depuis
// /admin/tech (§11.19, Phase 6A).
export default function EventPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}
