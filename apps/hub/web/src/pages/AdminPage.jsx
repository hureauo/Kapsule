import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken } from '../api/client.js';

// ── Utilitaires ───────────────────────────────────────────────────────────────

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

function CopyButton({ text, label = 'Copier', labelDone = '✓', className = 'btn btn--ghost btn--sm' }) {
  const [done, setDone] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).catch(() => {});
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  }
  return <button className={className} onClick={copy}>{done ? labelDone : label}</button>;
}

// ── Onglet Dashboard ──────────────────────────────────────────────────────────

function DashboardTab({ overview }) {
  const { events, disk, failed_jobs, boxes } = overview;
  const diskPct = disk.total_bytes > 0
    ? Math.round((1 - disk.free_bytes / disk.total_bytes) * 100)
    : 0;
  const diskLow = disk.free_bytes < 10 * 1024 * 1024 * 1024;
  const activeBoxes = boxes.filter((b) => !b.is_preview).length;
  const previewBoxes = boxes.filter((b) => b.is_preview).length;

  return (
    <>
      <div className="dashboard-grid">
        <div className="dash-card">
          <span className="dash-card__value">{events.length}</span>
          <span className="dash-card__label">Événements</span>
        </div>
        <div className="dash-card">
          <span className="dash-card__value">{activeBoxes}</span>
          <span className="dash-card__label">Bornes réelles</span>
        </div>
        <div className="dash-card">
          <span className="dash-card__value">{previewBoxes}</span>
          <span className="dash-card__label">Bornes d'essai</span>
        </div>
        <div className={`dash-card ${failed_jobs.length > 0 ? 'dash-card--alert' : ''}`}>
          <span className="dash-card__value">{failed_jobs.length}</span>
          <span className="dash-card__label">Jobs en erreur</span>
        </div>
      </div>

      <section className="panel-section" style={{ marginTop: '24px' }}>
        <h2 className="panel-section__title">Disque</h2>
        <div className={`disk-bar-wrap ${diskLow ? 'disk-bar-wrap--low' : ''}`}>
          <div className="disk-bar" style={{ width: `${diskPct}%` }} />
        </div>
        <p className="text--muted">
          {formatBytes(disk.total_bytes - disk.free_bytes)} utilisés /&nbsp;
          {formatBytes(disk.total_bytes)} total ({diskPct}%)
          {diskLow && <strong className="disk-warn"> — Espace disque faible !</strong>}
        </p>
      </section>

      {failed_jobs.length > 0 && (
        <section className="panel-section">
          <h2 className="panel-section__title">Jobs en erreur récents</h2>
          <table className="admin-table">
            <thead>
              <tr><th>#</th><th>Type</th><th>Événement</th><th>Erreur</th><th>Tentatives</th><th>Fin</th></tr>
            </thead>
            <tbody>
              {failed_jobs.map((j) => (
                <tr key={j.id}>
                  <td className="text--muted">{j.id}</td>
                  <td>{j.type}</td>
                  <td className="text--muted">{j.event_id}</td>
                  <td className="text--muted" style={{ maxWidth: 240, wordBreak: 'break-word' }}>{j.error}</td>
                  <td>{j.attempts}</td>
                  <td className="text--muted">{formatDate(j.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

// ── Formulaire de création d'événement ───────────────────────────────────────

function CreateEventForm({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setErr('');
    try {
      await api.createEvent(name.trim(), date || undefined);
      setName(''); setDate(''); setOpen(false);
      onCreated();
    } catch (error) {
      setErr(error.message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn--primary btn--sm" onClick={() => setOpen(true)}>
        + Nouvel événement
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="create-event-form">
      <input
        className="hub-input hub-input--sm"
        placeholder="Nom de l'événement"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        required
      />
      <input
        type="date"
        className="hub-input hub-input--sm"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      {err && <p className="error-msg">{err}</p>}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button type="submit" className="btn btn--primary btn--sm" disabled={loading || !name.trim()}>
          {loading ? 'Création…' : 'Créer'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); setErr(''); }}>
          Annuler
        </button>
      </div>
    </form>
  );
}

// ── Panneau d'un événement (inline) ──────────────────────────────────────────

function EventPanel({ event, onRefresh }) {
  const [tokens, setTokens] = useState(null);
  const [hubConfigHash, setHubConfigHash] = useState(null);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerResult, setOwnerResult] = useState(null);
  const [ownerErr, setOwnerErr] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [tokenForm, setTokenForm] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenLocation, setTokenLocation] = useState('');
  const [isPreview, setIsPreview] = useState(false);
  const [tokenErr, setTokenErr] = useState('');

  const loadTokens = useCallback(async () => {
    try {
      const res = await api.listBoxTokens(event.id);
      setTokens(res.tokens);
      setHubConfigHash(res.hub_config_hash);
    } catch { /* ignore */ }
  }, [event.id]);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  async function handleAssignOwner(e) {
    e.preventDefault();
    setOwnerErr('');
    setOwnerResult(null);
    try {
      const res = await api.assignEventOwner(event.id, ownerEmail.trim());
      setOwnerResult(res);
      setOwnerEmail('');
      onRefresh();
    } catch (err) {
      setOwnerErr(err.message);
    }
  }

  async function handleGenerateToken(e) {
    e.preventDefault();
    setTokenErr('');
    try {
      await api.createBoxToken(event.id, {
        label: tokenLabel.trim() || undefined,
        location: tokenLocation.trim() || undefined,
        is_preview: isPreview,
      });
      setTokenLabel(''); setTokenLocation(''); setIsPreview(false); setTokenForm(false);
      loadTokens();
    } catch (err) {
      setTokenErr(err.message);
    }
  }

  async function handleRevoke(tokenId, confirmed) {
    if (!confirmed) { setRevoking(tokenId); return; }
    try {
      await api.deleteBoxToken(tokenId);
      setRevoking(null);
      loadTokens();
    } catch { /* ignore */ }
  }

  const hubUrl = window.location.origin;

  function dockerCmd(t) {
    const file = t.is_preview ? 'docker-compose.preview.yml' : 'docker-compose.borne.yml';
    const varName = t.is_preview ? 'BOX_TOKEN_PREVIEW' : 'BOX_TOKEN';
    const tlsFlag = t.is_preview ? '' : ' NODE_TLS_REJECT_UNAUTHORIZED=0';
    return `${varName}=${t.token_clear} HUB_URL=${hubUrl}${tlsFlag} docker compose -f ${file} up --build`;
  }

  return (
    <div className="event-panel">
      {/* Bloc owner */}
      <div className="event-panel__section">
        <p className="event-panel__label">Client assigné</p>
        {event.owner_email
          ? <p className="event-panel__owner">{event.owner_email}</p>
          : <p className="text--muted" style={{ fontSize: '13px' }}>Aucun client assigné</p>
        }
        <form onSubmit={handleAssignOwner} className="owner-form">
          <input
            className="hub-input hub-input--sm"
            type="email"
            placeholder="email@client.fr"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
          <button type="submit" className="btn btn--ghost btn--sm" disabled={!ownerEmail.trim()}>
            Assigner
          </button>
        </form>
        {ownerErr && <p className="error-msg">{ownerErr}</p>}
        {ownerResult?.created && ownerResult.registration_url && (
          <div className="reg-link-box">
            <span className="text--muted" style={{ fontSize: '12px' }}>Nouveau compte — lien d'enregistrement :</span>
            <code className="reg-link-code">{ownerResult.registration_url}</code>
            <CopyButton text={ownerResult.registration_url} label="Copier le lien" labelDone="✓ Copié" />
          </div>
        )}
      </div>

      {/* Bloc tokens */}
      <div className="event-panel__section">
        <p className="event-panel__label">Tokens de borne</p>
        {hubConfigHash && (
          <p className="text--muted" style={{ fontSize: '12px', marginBottom: '8px' }}>
            Hash config Hub : <code className="token-code">{hubConfigHash}…</code>
          </p>
        )}
        {tokens === null ? (
          <p className="text--muted">Chargement…</p>
        ) : tokens.length === 0 ? (
          <p className="text--muted" style={{ fontSize: '13px' }}>Aucun token.</p>
        ) : (
          <div className="token-list">
            {tokens.map((t) => (
              <div key={t.id} className="token-item">
                <div className="token-item__top">
                  <span className="token-item__label">{t.label || <em className="text--muted">Sans label</em>}</span>
                  {t.location && <span className="text--muted" style={{ fontSize: '12px' }}>{t.location}</span>}
                  <span className={`status-badge ${t.is_preview ? 'status-badge--draft' : 'status-badge--ready'}`}>
                    {t.is_preview ? 'Essai' : 'Réel'}
                  </span>
                  {t.last_seen_at && (
                    <span className="text--muted" style={{ fontSize: '11px' }}>
                      vu {formatDate(t.last_seen_at)}
                    </span>
                  )}
                </div>
                <div className="token-item__row">
                  <code className="token-code">{t.token_clear}</code>
                  <CopyButton text={t.token_clear} label="Token" labelDone="✓" />
                  <CopyButton text={dockerCmd(t)} label="Cmd" labelDone="✓ Cmd" />
                  {revoking === t.id ? (
                    <>
                      <button className="btn btn--danger btn--sm" onClick={() => handleRevoke(t.id, true)}>Confirmer</button>
                      <button className="btn btn--ghost btn--sm" onClick={() => setRevoking(null)}>Annuler</button>
                    </>
                  ) : (
                    <button className="btn btn--ghost btn--sm" onClick={() => handleRevoke(t.id, false)}>Révoquer</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tokenForm ? (
          <form onSubmit={handleGenerateToken} className="token-gen-form">
            <input className="hub-input hub-input--sm" placeholder="Label" value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} autoFocus />
            <input className="hub-input hub-input--sm" placeholder="Emplacement" value={tokenLocation} onChange={(e) => setTokenLocation(e.target.value)} />
            <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={isPreview} onChange={(e) => setIsPreview(e.target.checked)} />
              Mode essai
            </label>
            {tokenErr && <p className="error-msg">{tokenErr}</p>}
            <div style={{ display: 'flex', gap: '6px' }}>
              <button type="submit" className="btn btn--primary btn--sm">Générer</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTokenForm(false)}>Annuler</button>
            </div>
          </form>
        ) : (
          <button className="btn btn--ghost btn--sm" style={{ marginTop: '8px' }} onClick={() => setTokenForm(true)}>
            + Générer un token
          </button>
        )}
      </div>
    </div>
  );
}

// ── Onglet Événements ─────────────────────────────────────────────────────────

function EventsTab() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  // Enrichir les événements avec l'email du owner depuis la vue d'ensemble
  const [ownersMap, setOwnersMap] = useState({});

  const load = useCallback(async () => {
    try {
      const [evList, overview] = await Promise.all([api.listEvents(), api.getOverview()]);
      setEvents(evList);
      const map = {};
      for (const ev of overview.events) {
        map[ev.id] = ev.owner_email;
      }
      setOwnersMap(map);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggle(id) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <div className="panel-section-header">
        <h2 className="panel-section__title">Événements</h2>
        <CreateEventForm onCreated={load} />
      </div>
      {error && <p className="error-msg">{error}</p>}
      {events.length === 0 ? (
        <p className="text--muted">Aucun événement. Créez-en un avec le bouton ci-dessus.</p>
      ) : (
        <div className="ev-list">
          {events.map((ev) => (
            <div key={ev.id} className="ev-row">
              <div className="ev-row__header" onClick={() => toggle(ev.id)}>
                <div className="ev-row__info">
                  <a
                    href={`/events/${ev.id}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{ fontWeight: 600 }}
                  >
                    {ev.name}
                  </a>
                  <span className={`status-badge status-badge--${ev.status}`}>{ev.status}</span>
                  {ev.event_date && (
                    <span className="text--muted" style={{ fontSize: '12px' }}>
                      {new Date(ev.event_date).toLocaleDateString('fr-FR')}
                    </span>
                  )}
                  {ownersMap[ev.id] && (
                    <span className="text--muted" style={{ fontSize: '12px' }}>· {ownersMap[ev.id]}</span>
                  )}
                </div>
                <span className="text--muted ev-row__toggle">
                  {expanded === ev.id ? '▲' : '▼'}
                </span>
              </div>
              {expanded === ev.id && (
                <EventPanel
                  event={{ ...ev, owner_email: ownersMap[ev.id] }}
                  onRefresh={load}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Onglet Tokens (vue globale) ───────────────────────────────────────────────

function TokensTab() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(async () => {
    try {
      setTokens(await api.listAllTokens());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRevoke(tokenId, confirmed) {
    if (!confirmed) { setRevoking(tokenId); return; }
    try {
      await api.deleteBoxToken(tokenId);
      setRevoking(null);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  const hubUrl = window.location.origin;
  function dockerCmd(t) {
    const file = t.is_preview ? 'docker-compose.preview.yml' : 'docker-compose.borne.yml';
    const varName = t.is_preview ? 'BOX_TOKEN_PREVIEW' : 'BOX_TOKEN';
    const tlsFlag = t.is_preview ? '' : ' NODE_TLS_REJECT_UNAUTHORIZED=0';
    return `${varName}=${t.token_clear} HUB_URL=${hubUrl}${tlsFlag} docker compose -f ${file} up --build`;
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Tous les tokens ({tokens.length})</h2>
      {error && <p className="error-msg">{error}</p>}
      {tokens.length === 0 ? (
        <p className="text--muted">Aucun token généré. Créez-en depuis l'onglet Événements.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Événement</th>
              <th>Label</th>
              <th>Type</th>
              <th>Token</th>
              <th>Dernière vue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.event_name ?? <span className="text--muted">—</span>}</td>
                <td>{t.label ?? <span className="text--muted">—</span>}</td>
                <td>
                  <span className={`status-badge ${t.is_preview ? 'status-badge--draft' : 'status-badge--ready'}`}>
                    {t.is_preview ? 'Essai' : 'Réel'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <code style={{ fontSize: '11px', wordBreak: 'break-all' }}>{t.token_clear}</code>
                    <CopyButton text={t.token_clear} label="Token" labelDone="✓" />
                    <CopyButton text={dockerCmd(t)} label="Cmd" labelDone="✓" />
                  </div>
                </td>
                <td className="text--muted">{formatDate(t.last_seen_at)}</td>
                <td>
                  {revoking === t.id ? (
                    <>
                      <button className="btn btn--danger btn--sm" onClick={() => handleRevoke(t.id, true)}>Confirmer</button>
                      <button className="btn btn--ghost btn--sm" onClick={() => setRevoking(null)}>Annuler</button>
                    </>
                  ) : (
                    <button className="btn btn--ghost btn--sm" onClick={() => handleRevoke(t.id, false)}>Révoquer</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── Onglet Bornes (placeholder) ───────────────────────────────────────────────

function BornesTab() {
  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Gestion des bornes</h2>
      <div className="placeholder-box">
        <p style={{ fontWeight: 600, marginBottom: '8px' }}>Fonctionnalité à venir</p>
        <p className="text--muted">
          Cette section affichera l'état live des Raspberrys connectés : statut de session,
          dernière synchronisation, consommation disque par borne.
        </p>
        <p className="text--muted" style={{ marginTop: '8px' }}>
          Une console SSH distante est également prévue pour le débogage à distance
          (xterm.js + WebSocket relayé via le Hub).
        </p>
      </div>
    </section>
  );
}

// ── Onglet Utilisateurs ───────────────────────────────────────────────────────

function UsersTab() {
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
      navigator.clipboard.writeText(registration_url).catch(() => {});
      setCopiedLink(registration_url);
      setTimeout(() => setCopiedLink(''), 6000);
      setEmail(''); setName('');
      load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleNewLink(userId) {
    try {
      const { registration_url } = await api.createRegistrationLink(userId);
      navigator.clipboard.writeText(registration_url).catch(() => {});
      setCopiedLink(registration_url);
      setTimeout(() => setCopiedLink(''), 6000);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleToggleActive(user) {
    try {
      await api.updateUser(user.id, { active: user.active ? 0 : 1 });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Comptes clients</h2>
      {error && <p className="error-msg">{error}</p>}

      <form onSubmit={handleCreate} className="create-user-form">
        <input type="email" className="hub-input hub-input--sm" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <input type="text" className="hub-input hub-input--sm" placeholder="Nom (optionnel)" value={name}
          onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn--primary btn--sm" disabled={creating || !email.trim()}>
          {creating ? 'Création…' : '+ Créer'}
        </button>
      </form>
      {createError && <p className="error-msg">{createError}</p>}

      {copiedLink && (
        <div className="reg-link-box" style={{ marginTop: '8px' }}>
          <span className="text--muted" style={{ fontSize: '12px' }}>Lien d'enregistrement (copié) :</span>
          <code className="reg-link-code">{copiedLink}</code>
        </div>
      )}

      {users.length === 0 ? (
        <p className="text--muted" style={{ marginTop: '12px' }}>Aucun client enregistré.</p>
      ) : (
        <table className="admin-table" style={{ marginTop: '16px' }}>
          <thead>
            <tr><th>Email</th><th>Nom</th><th>Mot de passe</th><th>Actif</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>{u.email}</td>
                <td className="text--muted">{u.name ?? '—'}</td>
                <td>{u.has_password ? '✓' : <span className="text--muted">Non défini</span>}</td>
                <td>{u.active ? 'Oui' : 'Non'}</td>
                <td style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => handleNewLink(u.id)}>
                    Lien
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => handleToggleActive(u)}>
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
  { id: 'dashboard',    label: 'Dashboard' },
  { id: 'events',       label: 'Événements' },
  { id: 'tokens',       label: 'Tokens' },
  { id: 'bornes',       label: 'Bornes' },
  { id: 'utilisateurs', label: 'Utilisateurs' },
];

export default function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('dashboard');
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadOverview() {
    try {
      setOverview(await api.getOverview());
    } catch (err) {
      if (err.status === 401) { clearToken(); navigate('/login', { replace: true }); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);

  function logout() { clearToken(); navigate('/login', { replace: true }); }

  if (loading) return <div className="hub-page"><p className="text--muted" style={{ padding: '24px' }}>Chargement…</p></div>;
  if (error) return <div className="hub-page"><p className="error-msg" style={{ padding: '24px' }}>{error}</p></div>;

  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="hub-logo">Kapsule</span>
        <span className="hub-header__title">Administration</span>
        <button className="btn btn--ghost btn--sm" onClick={logout}>Déconnexion</button>
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

        {tab === 'dashboard'    && <DashboardTab overview={overview} />}
        {tab === 'events'       && <EventsTab />}
        {tab === 'tokens'       && <TokensTab />}
        {tab === 'bornes'       && <BornesTab />}
        {tab === 'utilisateurs' && <UsersTab />}
      </main>
    </div>
  );
}
