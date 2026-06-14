import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

const POLL_MS = 2000;

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR');
}

export default function SyncPanel() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [pushError, setPushError] = useState('');
  const [purgeEventId, setPurgeEventId] = useState(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purgeMsg, setPurgeMsg] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getSyncStatus();
      setStatus(s);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const evs = await api.listEvents();
      setEvents(evs);
    } catch { /* non bloquant */ }
  }, []);

  useEffect(() => {
    loadStatus();
    loadEvents();
    const id = setInterval(loadStatus, POLL_MS);
    return () => clearInterval(id);
  }, [loadStatus, loadEvents]);

  async function handlePull() {
    try {
      await api.triggerPull();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePush(eventId) {
    setPushError('');
    try {
      await api.triggerPush(eventId);
      await loadStatus();
    } catch (err) {
      setPushError(err.message);
    }
  }

  async function handlePurge(e) {
    e.preventDefault();
    const ev = events.find(ev => ev.id === purgeEventId);
    if (!ev) return;
    setPurgeMsg('');
    try {
      await api.purgeEvent(purgeEventId, purgeConfirm);
      setPurgeEventId(null);
      setPurgeConfirm('');
      setPurgeMsg('Événement purgé.');
      await loadEvents();
    } catch (err) {
      setPurgeMsg(`Erreur : ${err.message}`);
    }
  }

  const push = status?.push ?? { running: false, total: 0, done: 0, currentFile: null };
  const closedEvents = events.filter(ev => ev.status === 'closed');
  const pushedEvents = events.filter(ev => ev.status === 'pushed');

  return (
    <div className="sync-panel">
      <h2 className="panel-title">Synchronisation Hub</h2>
      {error && <p className="error-msg">{error}</p>}

      {/* Statut de connexion */}
      <section className="panel-section">
        <h3 className="panel-section__title">Connexion Hub</h3>
        <div className="sync-row">
          <span className={`sync-badge${status?.online ? ' sync-badge--online' : ' sync-badge--offline'}`}>
            {status?.online ? 'En ligne' : 'Hors ligne'}
          </span>
          {status?.hubUrl && (
            <span className="text--muted sync-url">{status.hubUrl}</span>
          )}
        </div>
        <p className="text--muted">
          Dernier pull : {formatDate(status?.lastPull)}
        </p>
        <button
          className="btn btn--secondary btn--small"
          onClick={handlePull}
          disabled={!status?.online}
        >
          Pull maintenant
        </button>
      </section>

      {/* Push d'un événement */}
      <section className="panel-section">
        <h3 className="panel-section__title">Push vers le Hub</h3>

        {!push.running && (push.lastError || pushError) && (
          <p className="error-msg">
            {push.lastError?.message || pushError}
          </p>
        )}

        {push.running ? (
          <div className="push-progress">
            <p className="text--muted">Push en cours…</p>
            {push.total > 0 && (
              <>
                <div className="progress-bar">
                  <div
                    className="progress-bar__fill"
                    style={{ width: `${Math.round((push.done / push.total) * 100)}%` }}
                  />
                </div>
                <p className="text--muted">
                  {push.done} / {push.total} fichiers
                  {push.currentFile && ` — ${push.currentFile}`}
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {closedEvents.length === 0 ? (
              <p className="text--muted">Aucun événement clôturé à pousser.</p>
            ) : (
              <ul className="sync-event-list">
                {closedEvents.map(ev => (
                  <li key={ev.id} className="sync-event-item">
                    <span>{ev.name}</span>
                    <button
                      className="btn btn--primary btn--small"
                      onClick={() => handlePush(ev.id)}
                      disabled={!status?.online}
                    >
                      PUSH
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Purge RGPD */}
      {pushedEvents.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">Purge locale (après push)</h3>
          {purgeMsg && <p className="text--muted">{purgeMsg}</p>}
          {purgeEventId === null ? (
            <ul className="sync-event-list">
              {pushedEvents.map(ev => (
                <li key={ev.id} className="sync-event-item">
                  <span>{ev.name}</span>
                  <button
                    className="btn btn--danger btn--small"
                    onClick={() => { setPurgeEventId(ev.id); setPurgeConfirm(''); setPurgeMsg(''); }}
                  >
                    Purger
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form onSubmit={handlePurge} className="purge-form">
              <p className="text--warn">
                Cette action supprime définitivement tous les fichiers locaux de l'événement
                « {events.find(ev => ev.id === purgeEventId)?.name} ».
              </p>
              <label className="field-label">
                Saisir le nom de l'événement pour confirmer
                <input
                  className="admin-input"
                  type="text"
                  value={purgeConfirm}
                  onChange={e => setPurgeConfirm(e.target.value)}
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
          )}
        </section>
      )}
    </div>
  );
}
