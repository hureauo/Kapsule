import React, { useState, useEffect, useCallback } from 'react';
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

// ── Onglet Vue d'ensemble ────────────────────────────────────────────────────

function OverviewTab({ overview }) {
  const { events, disk, failed_jobs } = overview;
  const diskPct = disk.total_bytes > 0
    ? Math.round((1 - disk.free_bytes / disk.total_bytes) * 100)
    : 0;
  const diskLow = disk.free_bytes < 10 * 1024 * 1024 * 1024;

  return (
    <>
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
                  <td><a href={`/events/${ev.id}`}>{ev.name}</a></td>
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

      <section className="panel-section">
        <h2 className="panel-section__title">Jobs en erreur récents</h2>
        {failed_jobs.length === 0 ? (
          <p className="text--muted">Aucun job en erreur.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th><th>Type</th><th>Événement</th>
                <th>Erreur</th><th>Tentatives</th><th>Fin</th>
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
    </>
  );
}

// ── Génération de token (inline, par événement) ───────────────────────────────

function TokenGenerator({ eventId, onGenerated }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [location, setLocation] = useState('');
  const [isPreview, setIsPreview] = useState(false);
  const [err, setErr] = useState('');
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setOpen(false);
    setLabel('');
    setLocation('');
    setIsPreview(false);
    setErr('');
    setNewToken(null);
    setCopied(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    try {
      const result = await api.createBoxToken(eventId, {
        label: label.trim() || undefined,
        location: location.trim() || undefined,
        is_preview: isPreview,
      });
      setNewToken(result.token);
      onGenerated();
    } catch (error) {
      setErr(error.message);
    }
  }

  function copyToken() {
    navigator.clipboard.writeText(newToken).catch(() => {});
    setCopied(true);
  }

  if (!open) {
    return (
      <button className="btn btn--primary btn--sm" onClick={() => setOpen(true)}>
        + Générer un token
      </button>
    );
  }

  if (newToken) {
    return (
      <div className="token-reveal">
        <p className="text--muted" style={{ marginBottom: '0.5rem' }}>
          Token (affiché <strong>une seule fois</strong>) :
        </p>
        <code className="token-display">{newToken}</code>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button className="btn btn--primary btn--sm" onClick={copyToken}>
            {copied ? 'Copié ✓' : 'Copier'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={reset}>Fermer</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="token-form">
      <input
        type="text"
        className="hub-input hub-input--sm"
        placeholder="Label (ex. Entrée)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        autoFocus
      />
      <input
        type="text"
        className="hub-input hub-input--sm"
        placeholder="Emplacement (optionnel)"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
        <input
          type="checkbox"
          checked={isPreview}
          onChange={(e) => setIsPreview(e.target.checked)}
        />
        Mode essai (is_preview)
      </label>
      {err && <p className="error-msg">{err}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn--primary btn--sm">Générer</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>Annuler</button>
      </div>
    </form>
  );
}

// ── Onglet Événements ─────────────────────────────────────────────────────────

function EventsTab() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [tokens, setTokens] = useState({});
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listEvents();
      setEvents(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function loadTokens(eventId) {
    try {
      const list = await api.listBoxTokens(eventId);
      setTokens((prev) => ({ ...prev, [eventId]: list }));
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleExpand(eventId) {
    if (expanded === eventId) {
      setExpanded(null);
    } else {
      setExpanded(eventId);
      await loadTokens(eventId);
    }
  }

  async function handleRevoke(tokenId, eventId) {
    try {
      await api.deleteBoxToken(tokenId);
      setRevoking(null);
      await loadTokens(eventId);
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Événements et tokens de borne</h2>
      {error && <p className="error-msg">{error}</p>}
      {events.length === 0 ? (
        <p className="text--muted">Aucun événement.</p>
      ) : (
        <div className="events-token-list">
          {events.map((ev) => (
            <div key={ev.id} className="event-token-row">
              <div
                className="event-token-row__header"
                onClick={() => toggleExpand(ev.id)}
                style={{ cursor: 'pointer' }}
              >
                <div>
                  <strong>{ev.name}</strong>
                  <span className={`status-badge status-badge--${ev.status}`} style={{ marginLeft: '0.5rem' }}>
                    {ev.status}
                  </span>
                </div>
                <span className="text--muted" style={{ fontSize: '0.85rem' }}>
                  {expanded === ev.id ? '▲ Fermer' : '▼ Tokens'}
                </span>
              </div>

              {expanded === ev.id && (
                <div className="event-token-row__body">
                  {(tokens[ev.id] ?? []).length === 0 ? (
                    <p className="text--muted" style={{ fontSize: '0.875rem' }}>
                      Aucun token actif.
                    </p>
                  ) : (
                    <table className="admin-table admin-table--sm">
                      <thead>
                        <tr>
                          <th>Label</th><th>Emplacement</th>
                          <th>Essai</th><th>Dernière vue</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tokens[ev.id] ?? []).map((t) => (
                          <tr key={t.id}>
                            <td>{t.label ?? <span className="text--muted">—</span>}</td>
                            <td className="text--muted">{t.location ?? '—'}</td>
                            <td>{t.is_preview ? 'Oui' : 'Non'}</td>
                            <td className="text--muted">{formatDate(t.last_seen_at)}</td>
                            <td>
                              {revoking === t.id ? (
                                <>
                                  <button className="btn btn--danger btn--sm"
                                    onClick={() => handleRevoke(t.id, ev.id)}>
                                    Confirmer
                                  </button>
                                  <button className="btn btn--ghost btn--sm"
                                    onClick={() => setRevoking(null)}>
                                    Annuler
                                  </button>
                                </>
                              ) : (
                                <button className="btn btn--ghost btn--sm"
                                  onClick={() => setRevoking(t.id)}>
                                  Révoquer
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div style={{ marginTop: '0.75rem' }}>
                    <TokenGenerator
                      eventId={ev.id}
                      onGenerated={() => loadTokens(ev.id)}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
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
      const { registration_url } = await api.createUser(email.trim(), name.trim() || undefined);
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
              <th>Email</th><th>Nom</th><th>Mot de passe</th><th>Actif</th><th>Actions</th>
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

const TABS = [
  { id: 'overview', label: 'Vue d\'ensemble' },
  { id: 'events',   label: 'Événements' },
  { id: 'clients',  label: 'Clients' },
];

export default function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  if (loading) return <div className="hub-page"><p className="text--muted">Chargement…</p></div>;
  if (error) return <div className="hub-page"><p className="error-msg">{error}</p></div>;

  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="hub-header__title">Administration</span>
        <button className="btn btn--ghost"
          onClick={() => { clearToken(); navigate('/login', { replace: true }); }}>
          Déconnexion
        </button>
      </header>

      <main className="hub-main">
        <nav className="admin-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`admin-tab${tab === t.id ? ' admin-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'overview' && <OverviewTab overview={overview} />}
        {tab === 'events'   && <EventsTab />}
        {tab === 'clients'  && <ClientsSection />}
      </main>
    </div>
  );
}
