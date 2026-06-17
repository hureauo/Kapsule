import React, { useState, useEffect, useRef, useCallback } from 'react';
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

// ── Section Clients ───────────────────────────────────────────────────────────

function ClientsSection() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [copiedLink, setCopiedLink] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    try {
      const { user, registration_url } = await api.createUser(email.trim(), name.trim() || undefined);
      void user;
      await copyLink(registration_url);
      await load();
      setEmail('');
      setName('');
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function copyLink(url) {
    try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
    setCopiedLink(url);
    setTimeout(() => setCopiedLink(''), 3000);
  }

  async function handleNewLink(userId) {
    try {
      const { registration_url } = await api.createRegistrationLink(userId);
      await copyLink(registration_url);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleToggleActive(user) {
    try {
      await api.updateUser(user.id, { active: user.active ? 0 : 1 });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Clients</h2>
      {error && <p className="error-msg">{error}</p>}

      <form onSubmit={handleCreate} className="inline-form" style={{ marginBottom: '1rem' }}>
        <input
          type="email"
          className="hub-input"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="text"
          className="hub-input"
          placeholder="Nom (optionnel)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={creating || !email.trim()}>
          {creating ? 'Création…' : '+ Créer'}
        </button>
      </form>
      {createError && <p className="error-msg">{createError}</p>}
      {copiedLink && (
        <p className="text--muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          Lien copié : <code style={{ wordBreak: 'break-all' }}>{copiedLink}</code>
        </p>
      )}

      {users.length === 0 ? (
        <p className="text--muted">Aucun client enregistré.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Nom</th>
              <th>Mot de passe</th>
              <th>Actif</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>{u.email}</td>
                <td className="text--muted">{u.name ?? '—'}</td>
                <td>{u.has_password ? '✓' : <span className="text--muted">Non défini</span>}</td>
                <td>{u.active ? 'Oui' : 'Non'}</td>
                <td style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => handleNewLink(u.id)}
                    title="Générer un nouveau lien d'enregistrement"
                  >
                    Lien
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => handleToggleActive(u)}
                  >
                    {u.active ? 'Désactiver' : 'Réactiver'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

        {/* ── Clients ─────────────────────────────────────────────────────── */}
        <ClientsSection />

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
