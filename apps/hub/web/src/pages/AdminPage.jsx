import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken } from '../api/client.js';

function formatBytes(b) {
  if (!b) return '0 o';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} Ko`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR');
}

// ── Modale création borne ─────────────────────────────────────────────────────

function NewBoxModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState(null);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  async function handleCreate(e) {
    e.preventDefault();
    setErr('');
    try {
      const box = await api.createBox(name.trim());
      setToken(box.token);
      onCreate();
    } catch (error) {
      setErr(error.message);
    }
  }

  function copyToken() {
    navigator.clipboard.writeText(token).catch(() => {});
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title">Créer une borne</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>

        {token ? (
          <div className="new-box-token">
            <p className="text--muted">
              Token de la borne (affiché <strong>une seule fois</strong>) :
            </p>
            <code className="token-display">{token}</code>
            <button className="btn btn--primary btn--sm" onClick={copyToken}>
              Copier
            </button>
            <p className="text--muted" style={{ marginTop: 8 }}>
              Conservez ce token — il ne sera plus affiché.
            </p>
            <button className="btn btn--ghost" onClick={onClose} style={{ marginTop: 12 }}>
              Fermer
            </button>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="modal-form">
            <label className="field-label">
              Nom de la borne
              <input
                ref={inputRef}
                type="text"
                className="hub-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </label>
            {err && <p className="error-msg">{err}</p>}
            <div className="modal-footer">
              <button type="button" className="btn btn--ghost" onClick={onClose}>Annuler</button>
              <button type="submit" className="btn btn--primary" disabled={!name.trim()}>Créer</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── AdminPage ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNewBox, setShowNewBox] = useState(false);
  const [deletingBox, setDeletingBox] = useState(null);

  async function loadOverview() {
    try {
      const data = await api.getOverview();
      setOverview(data);
    } catch (err) {
      if (err.status === 401) { clearToken(); navigate('/login', { replace: true }); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);

  async function handleDeleteBox(id) {
    try {
      await api.deleteBox(id);
      setDeletingBox(null);
      await loadOverview();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="hub-page"><p className="text--muted">Chargement…</p></div>;
  if (error) return <div className="hub-page"><p className="error-msg">{error}</p></div>;

  const { events, disk, failed_jobs, boxes } = overview;
  const diskPct = disk.total_bytes > 0
    ? Math.round((1 - disk.free_bytes / disk.total_bytes) * 100)
    : 0;
  const diskLow = disk.free_bytes < 10 * 1024 * 1024 * 1024;

  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="hub-header__title">Administration</span>
        <button className="btn btn--ghost" onClick={() => { clearToken(); navigate('/login', { replace: true }); }}>
          Déconnexion
        </button>
      </header>

      <main className="hub-main">

        {/* ── Disque ──────────────────────────────────────────────────────── */}
        <section className="panel-section">
          <h2 className="panel-section__title">Disque</h2>
          <div className={`disk-bar-wrap ${diskLow ? 'disk-bar-wrap--low' : ''}`}>
            <div className="disk-bar" style={{ width: `${diskPct}%` }} />
          </div>
          <p className="text--muted">
            {formatBytes(disk.total_bytes - disk.free_bytes)} utilisés /
            {' '}{formatBytes(disk.total_bytes)} total
            {diskLow && <strong className="disk-warn"> — Espace disque faible !</strong>}
          </p>
        </section>

        {/* ── Bornes ──────────────────────────────────────────────────────── */}
        <section className="panel-section">
          <div className="panel-section-header">
            <h2 className="panel-section__title">Bornes</h2>
            <button className="btn btn--primary btn--sm" onClick={() => setShowNewBox(true)}>
              + Nouvelle borne
            </button>
          </div>
          {boxes.length === 0 ? (
            <p className="text--muted">Aucune borne enregistrée.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Dernière vue</th>
                  <th>Créée le</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {boxes.map((box) => (
                  <tr key={box.id}>
                    <td>{box.name}</td>
                    <td className="text--muted">{formatDate(box.last_seen_at)}</td>
                    <td className="text--muted">{formatDate(box.created_at)}</td>
                    <td>
                      {deletingBox === box.id ? (
                        <>
                          <button className="btn btn--danger btn--sm" onClick={() => handleDeleteBox(box.id)}>
                            Confirmer
                          </button>
                          <button className="btn btn--ghost btn--sm" onClick={() => setDeletingBox(null)}>
                            Annuler
                          </button>
                        </>
                      ) : (
                        <button className="btn btn--ghost btn--sm" onClick={() => setDeletingBox(box.id)}>
                          Révoquer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Événements ──────────────────────────────────────────────────── */}
        <section className="panel-section">
          <h2 className="panel-section__title">Tous les événements ({events.length})</h2>
          {events.length === 0 ? (
            <p className="text--muted">Aucun événement.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Propriétaire</th>
                  <th>Statut</th>
                  <th>Taille disque</th>
                  <th>Créé le</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      <a href={`/events/${ev.id}`}>{ev.name}</a>
                    </td>
                    <td className="text--muted">{ev.owner_email ?? '—'}</td>
                    <td>
                      <span className={`status-badge status-badge--${ev.status}`}>{ev.status}</span>
                    </td>
                    <td className="text--muted">{formatBytes(ev.disk_bytes)}</td>
                    <td className="text--muted">{formatDate(ev.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Jobs en erreur ───────────────────────────────────────────────── */}
        <section className="panel-section">
          <h2 className="panel-section__title">Jobs en erreur récents</h2>
          {failed_jobs.length === 0 ? (
            <p className="text--muted">Aucun job en erreur.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Événement</th>
                  <th>Erreur</th>
                  <th>Tentatives</th>
                  <th>Fin</th>
                </tr>
              </thead>
              <tbody>
                {failed_jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="text--muted">{j.id}</td>
                    <td>{j.type}</td>
                    <td className="text--muted">{j.event_id}</td>
                    <td className="text--muted" style={{ maxWidth: 300, wordBreak: 'break-word' }}>
                      {j.error}
                    </td>
                    <td>{j.attempts}</td>
                    <td className="text--muted">{formatDate(j.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

      </main>

      {showNewBox && (
        <NewBoxModal
          onClose={() => setShowNewBox(false)}
          onCreate={loadOverview}
        />
      )}
    </div>
  );
}
