import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken, getRole } from '../api/client.js';
import { formatBytes, formatDate } from '../utils/format.js';

// ── Utilitaires ───────────────────────────────────────────────────────────────

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
          <div className="table-scroll">
            <table className="admin-table responsive-table">
              <thead>
                <tr><th>#</th><th>Type</th><th>Événement</th><th>Erreur</th><th>Tentatives</th><th>Fin</th></tr>
              </thead>
              <tbody>
                {failed_jobs.map((j) => (
                  <tr key={j.id}>
                    <td data-label="#" className="text--muted">{j.id}</td>
                    <td data-label="Type">{j.type}</td>
                    <td data-label="Événement" className="text--muted">{j.event_id}</td>
                    <td data-label="Erreur" className="text--muted" style={{ maxWidth: 240, wordBreak: 'break-word' }}>{j.error}</td>
                    <td data-label="Tentatives">{j.attempts}</td>
                    <td data-label="Fin" className="text--muted">{formatDate(j.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

const BORNE_ROLES = ['admin_borne', 'tech_borne', 'general'];
const BORNE_ROLE_LABELS = { admin_borne: 'Admin borne', tech_borne: 'Technicien', general: 'Général' };

function EventPanel({ event, onRefresh, canDelete, onDelete }) {
  const [tokens, setTokens] = useState(null);
  const [hubConfigHash, setHubConfigHash] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [tokenForm, setTokenForm] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenLocation, setTokenLocation] = useState('');
  const [isPreview, setIsPreview] = useState(false);
  const [tokenErr, setTokenErr] = useState('');

  // Preview auto-provisionnée
  const [previewStatus, setPreviewStatus] = useState(null);
  const [linkExpiry, setLinkExpiry] = useState('7d');
  const [generatedLink, setGeneratedLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);

  // event_users
  const [eventUsers, setEventUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [usersMsg, setUsersMsg] = useState('');
  const [usersErr, setUsersErr] = useState('');

  const loadTokens = useCallback(async () => {
    try {
      const res = await api.listBoxTokens(event.id);
      setTokens(res.tokens);
      setHubConfigHash(res.hub_config_hash);
    } catch { /* ignore */ }
  }, [event.id]);

  const loadUsers = useCallback(async () => {
    try {
      const [eu, all] = await Promise.all([api.listEventUsers(event.id), api.listUsers()]);
      setEventUsers(eu);
      setAllUsers(all);
    } catch { /* ignore */ }
  }, [event.id]);

  const loadPreviewStatus = useCallback(async () => {
    try { setPreviewStatus(await api.previewStatus(event.id)); }
    catch { setPreviewStatus({ up: false, preview_url: null }); }
  }, [event.id]);

  const [toggling, setToggling] = useState(false);
  async function handleTogglePreview() {
    setToggling(true);
    try {
      if (previewStatus?.up) {
        await api.previewStop(event.id);
      } else {
        await api.previewStart(event.id);
      }
      await loadPreviewStatus();
    } catch (err) { alert(`Erreur : ${err.message}`); }
    finally { setToggling(false); }
  }

  useEffect(() => { loadTokens(); loadUsers(); loadPreviewStatus(); }, [loadTokens, loadUsers, loadPreviewStatus]);

  async function handleGenerateLink() {
    setLinkLoading(true);
    setGeneratedLink('');
    try {
      const { preview_url } = await api.generatePreviewToken(event.id, linkExpiry);
      setGeneratedLink(preview_url);
    } finally {
      setLinkLoading(false);
    }
  }

  function toggleRole(role) {
    setSelectedRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  }

  async function handleAddUser(e) {
    e.preventDefault();
    if (!selectedUserId || selectedRoles.length === 0) return;
    setUsersMsg(''); setUsersErr('');
    try {
      await api.addEventUser(event.id, Number(selectedUserId), selectedRoles);
      setSelectedUserId(''); setSelectedRoles([]);
      setUsersMsg('Utilisateur ajouté.');
      loadUsers();
    } catch (err) { setUsersErr(err.message); }
  }

  async function handleRemoveUser(userId) {
    setUsersMsg(''); setUsersErr('');
    try {
      await api.removeEventUser(event.id, userId);
      setUsersMsg('Retiré.');
      loadUsers();
    } catch (err) { setUsersErr(err.message); }
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

  const assignedIds = new Set(eventUsers.map(u => String(u.user_id)));
  const available = allUsers.filter(u => !assignedIds.has(String(u.id)) && u.active);

  return (
    <div className="event-panel">
      {/* Bloc utilisateurs assignés */}
      <div className="event-panel__section">
        <p className="event-panel__label">Utilisateurs assignés</p>
        {eventUsers.length === 0
          ? <p className="text--muted" style={{ fontSize: '13px' }}>Aucun utilisateur assigné.</p>
          : eventUsers.map(u => (
            <div key={u.user_id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', fontSize: '13px' }}>
              <span style={{ flex: 1 }}>
                <strong>{u.email}</strong>
                <span className="text--muted" style={{ marginLeft: '6px' }}>
                  {u.roles.map(r => BORNE_ROLE_LABELS[r] ?? r).join(', ')}
                </span>
              </span>
              <button className="btn btn--ghost btn--sm" onClick={() => handleRemoveUser(u.user_id)}>Retirer</button>
            </div>
          ))
        }


        {available.length > 0 && (
          <form onSubmit={handleAddUser} style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="hub-input hub-input--sm" value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} required>
                <option value="">— ajouter un utilisateur —</option>
                {available.map(u => (
                  <option key={u.id} value={u.id}>{u.email}{u.name ? ` (${u.name})` : ''}</option>
                ))}
              </select>
            </div>
            {selectedUserId && (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {BORNE_ROLES.map(role => (
                  <label key={role} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selectedRoles.includes(role)} onChange={() => toggleRole(role)} />
                    {BORNE_ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
            )}
            {selectedUserId && (
              <button type="submit" className="btn btn--ghost btn--sm" disabled={selectedRoles.length === 0}>
                Assigner
              </button>
            )}
          </form>
        )}
        {usersMsg && <p className="text--muted" style={{ fontSize: '12px', marginTop: '4px' }}>{usersMsg}</p>}
        {usersErr && <p className="error-msg" style={{ fontSize: '12px', marginTop: '4px' }}>{usersErr}</p>}
      </div>


      {/* Bloc configuration de l'événement */}
      <div className="event-panel__section">
        <p className="event-panel__label">Paramètres de l'événement</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <a
            href={`/events/${event.id}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn--primary btn--sm"
          >
            Configurer ↗
          </a>
        </div>
      </div>


      {/* Bloc preview */}
      <div className="event-panel__section">
        <p className="event-panel__label">Borne d'essai</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', fontSize: '13px' }}>
          {previewStatus === null && <span className="text--muted">Vérification…</span>}
          {previewStatus !== null && (
            <>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: previewStatus.up ? '#22c55e' : '#ef4444' }} />
              <span className="text--muted">{previewStatus.up ? 'En ligne' : 'Hors ligne'}</span>
              <button className="btn btn--ghost btn--sm" onClick={handleTogglePreview} disabled={toggling}>
                {toggling ? '…' : previewStatus.up ? 'Éteindre' : 'Démarrer'}
              </button>
              {previewStatus.up && previewStatus.preview_url && (
                <a href={previewStatus.preview_url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">Ouvrir ↗</a>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span className="text--muted" style={{ fontSize: '12px' }}>Lien JWT valide</span>
          <select value={linkExpiry} onChange={e => setLinkExpiry(e.target.value)} style={{ fontSize: '12px', padding: '2px 4px' }}>
            <option value="1d">1 jour</option>
            <option value="7d">7 jours</option>
            <option value="30d">30 jours</option>
          </select>
          <button className="btn btn--ghost btn--sm" onClick={handleGenerateLink} disabled={linkLoading}>
            {linkLoading ? 'Génération…' : 'Générer lien'}
          </button>
        </div>
        {generatedLink && (
          <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <code style={{ fontSize: '11px', wordBreak: 'break-all', flex: 1 }}>{generatedLink}</code>
            <CopyButton text={generatedLink} label="Copier" labelDone="✓" />
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

      {/* Bloc actions destructives sur l'événement */}
      <div className="event-panel__section">
        <p className="event-panel__label">Actions</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {canDelete && (
            <button className="btn btn--danger btn--sm" onClick={onDelete}>
              Supprimer l'événement
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Onglet Événements ─────────────────────────────────────────────────────────

// onDataChange : notifie le parent (AdminPage) qu'il doit recharger son overview
// (le Dashboard compte les événements) — sinon il reste figé sur l'ancienne liste.
function EventsTab({ onDataChange }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  // Suppression réservée aux superusers (garde réelle côté API : requireAdmin sur DELETE).
  // Ici on cache juste le bouton pour les non-superusers — pure cohérence UX.
  const isSuperuser = getRole() === 'superuser';

  const load = useCallback(async () => {
    try {
      setEvents(await api.listEvents());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Recharge la liste locale ET l'overview du parent (Dashboard).
  const reload = useCallback(async () => {
    await load();
    onDataChange?.();
  }, [load, onDataChange]);

  useEffect(() => { load(); }, [load]);

  function toggle(id) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  async function handleDelete(ev) {
    // Suppression totale : données invité + vidéos + container preview + ligne registre.
    // Le backend exige la saisie du nom exact (confirm) → double garde-fou anti-accident.
    const answer = prompt(
      `Supprimer définitivement « ${ev.name} » ?\n\n`
      + 'Cette action efface les vidéos, les données invité, le container preview '
      + "et toute trace de l'événement. Elle est IRRÉVERSIBLE.\n\n"
      + "Pour confirmer, tape le nom exact de l'événement :",
    );
    if (answer === null) return; // annulé
    try {
      await api.deleteEvent(ev.id, answer);
      if (expanded === ev.id) setExpanded(null);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <div className="panel-section-header">
        <h2 className="panel-section__title">Événements</h2>
        <CreateEventForm onCreated={reload} />
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
                </div>
                <span className="text--muted ev-row__toggle">
                  {expanded === ev.id ? '▲' : '▼'}
                </span>
              </div>
              {expanded === ev.id && (
                <EventPanel
                  event={ev}
                  onRefresh={load}
                  canDelete={isSuperuser}
                  onDelete={() => handleDelete(ev)}
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
        <div className="table-scroll">
          <table className="admin-table responsive-table">
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
                  <td data-label="Événement">{t.event_name ?? <span className="text--muted">—</span>}</td>
                  <td data-label="Label">{t.label ?? <span className="text--muted">—</span>}</td>
                  <td data-label="Type">
                    <span className={`status-badge ${t.is_preview ? 'status-badge--draft' : 'status-badge--ready'}`}>
                      {t.is_preview ? 'Essai' : 'Réel'}
                    </span>
                  </td>
                  <td data-label="Token">
                    <div className="token-cell">
                      <code className="token-cell__code">{t.token_clear}</code>
                      <CopyButton text={t.token_clear} label="Token" labelDone="✓" />
                      <CopyButton text={dockerCmd(t)} label="Cmd" labelDone="✓" />
                    </div>
                  </td>
                  <td data-label="Dernière vue" className="text--muted">{formatDate(t.last_seen_at)}</td>
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
        </div>
      )}
    </section>
  );
}

// ── Onglet Gestion email (journal des envois) ─────────────────────────────────

const EMAIL_TYPE_LABEL = { registration: 'Inscription', password_reset: 'Réinit. mot de passe' };
const EMAIL_STATUS_BADGE = { sent: 'status-badge--ready', failed: 'status-badge--closed', skipped: 'status-badge--waiting' };
const EMAIL_STATUS_LABEL = { sent: 'Envoyé', failed: 'Échec', skipped: 'Ignoré (SMTP off)' };

function EmailLogsTab() {
  const [logs, setLogs] = useState([]);
  const [smtp, setSmtp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listEmailLogs()
      .then((data) => { setLogs(data.logs); setSmtp(data.smtp); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Journal des emails ({logs.length})</h2>
      {error && <p className="error-msg">{error}</p>}
      {smtp && (
        smtp.configured ? (
          <div className="banner banner--ok">
            ✅ SMTP configuré — envoi via <strong>{smtp.host}:{smtp.port}</strong>, expéditeur <strong>{smtp.from}</strong>.
          </div>
        ) : (
          <div className="banner banner--warn">
            ⚠️ SMTP non configuré (<code>SMTP_HOST</code> vide). Aucun email n'est envoyé : les
            envois apparaissent en « Ignoré » et le lien reste copiable manuellement côté admin.
          </div>
        )
      )}
      <p className="text--muted" style={{ fontSize: '13px', marginBottom: '8px' }}>
        100 derniers envois. « Ignoré » = SMTP non configuré (le lien reste copiable côté admin).
      </p>
      {logs.length === 0 ? (
        <p className="text--muted">Aucun envoi enregistré.</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table responsive-table">
            <thead>
              <tr><th>Date</th><th>Destinataire</th><th>Type</th><th>Statut</th><th>Erreur</th></tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td data-label="Date" className="text--muted">{formatDate(l.created_at)}</td>
                  <td data-label="Destinataire">{l.recipient_email}</td>
                  <td data-label="Type">{EMAIL_TYPE_LABEL[l.type] ?? l.type}</td>
                  <td data-label="Statut">
                    <span className={`status-badge ${EMAIL_STATUS_BADGE[l.status] ?? ''}`}>
                      {EMAIL_STATUS_LABEL[l.status] ?? l.status}
                    </span>
                  </td>
                  <td data-label="Erreur" className="text--muted" style={{ maxWidth: 240, wordBreak: 'break-word' }}>
                    {l.error ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const [mailMsg, setMailMsg] = useState('');
  const myRole = getRole();

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

  // Envoie le mail de définition de mot de passe ET affiche le lien en fallback
  // (le backend renvoie toujours registration_url, même si l'envoi SMTP a échoué).
  // Confirmation préalable : l'envoi part vers une boîte tierce, action à ne pas
  // déclencher par mégarde (confirm() natif, cohérent avec le reste de l'app).
  async function handleSendMail(user) {
    if (!confirm(`Envoyer le mail d'inscription à ${user.email} ?`)) return;
    setMailMsg('');
    try {
      const { registration_url, email_sent } = await api.sendRegistration(user.id);
      setCopiedLink(registration_url);
      setMailMsg(email_sent
        ? 'Email envoyé.'
        : 'Email non envoyé (SMTP indisponible) — transmettez le lien manuellement.');
      setTimeout(() => { setCopiedLink(''); setMailMsg(''); }, 8000);
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

  async function handleToggleRole(user) {
    const newRole = user.role === 'superuser' ? 'client' : 'superuser';
    try {
      await api.updateUser(user.id, { role: newRole });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  // Nombre de superusers actifs (pour désactiver le bouton rétrograder sur le dernier)
  const superuserCount = users.filter(u => u.role === 'superuser' && u.active).length;

  if (loading) return <p className="text--muted">Chargement…</p>;

  return (
    <section className="panel-section">
      <h2 className="panel-section__title">Comptes utilisateurs</h2>
      {error && <p className="error-msg">{error}</p>}

      <form onSubmit={handleCreate} className="create-user-form">
        {/* autoComplete=off : l'admin crée un compte pour un tiers — ne pas proposer
            ni enregistrer sa propre adresse dans le trousseau du navigateur. */}
        <input type="email" autoComplete="off" className="hub-input hub-input--sm" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <input type="text" autoComplete="off" className="hub-input hub-input--sm" placeholder="Nom (optionnel)" value={name}
          onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn--primary btn--sm" disabled={creating || !email.trim()}>
          {creating ? 'Création…' : '+ Créer'}
        </button>
      </form>
      {createError && <p className="error-msg">{createError}</p>}

      {mailMsg && <p className="text--muted" style={{ marginTop: '8px', fontSize: '13px' }}>{mailMsg}</p>}
      {copiedLink && (
        <div className="reg-link-box" style={{ marginTop: '8px' }}>
          <span className="text--muted" style={{ fontSize: '12px' }}>Lien d'enregistrement (copié) :</span>
          <code className="reg-link-code">{copiedLink}</code>
        </div>
      )}

      {users.length === 0 ? (
        <p className="text--muted" style={{ marginTop: '12px' }}>Aucun utilisateur enregistré.</p>
      ) : (
        <div className="table-scroll" style={{ marginTop: '16px' }}>
        <table className="admin-table responsive-table">
          <thead>
            <tr><th>Email</th><th>Nom</th><th>Rôle</th><th>Mot de passe</th><th>Actif</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = myRole === 'superuser' && u.role === 'superuser';
              // Désactiver la rétrogradation si dernier superuser OU sur soi-même (le backend le bloque aussi)
              const canDemote = u.role === 'superuser' && superuserCount > 1;
              const canPromote = u.role === 'client';
              return (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td data-label="Email">{u.email}</td>
                  <td data-label="Nom" className="text--muted">{u.name ?? '—'}</td>
                  <td data-label="Rôle">
                    <span className={`status-badge ${u.role === 'superuser' ? 'status-badge--live' : 'status-badge--ready'}`}>
                      {u.role === 'superuser' ? 'Superuser' : 'Client'}
                    </span>
                  </td>
                  <td data-label="Mot de passe">{u.has_password ? '✓' : <span className="text--muted">Non défini</span>}</td>
                  <td data-label="Actif">{u.active ? 'Oui' : 'Non'}</td>
                  <td style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => handleSendMail(u)}>
                      Envoyer le mail
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => handleNewLink(u.id)}>
                      Lien
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => handleToggleActive(u)}>
                      {u.active ? 'Désactiver' : 'Réactiver'}
                    </button>
                    {(canPromote || canDemote) && (
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => handleToggleRole(u)}
                        title={canDemote ? 'Rétrograder en client' : 'Promouvoir en superuser'}
                      >
                        {u.role === 'superuser' ? '↓ Client' : '↑ Superuser'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
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
  { id: 'email',        label: 'Gestion email' },
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
        <div className="hub-header__actions">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/events')}>Événements</button>
          <button className="btn btn--ghost btn--sm" onClick={logout}>Déconnexion</button>
        </div>
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
        {tab === 'events'       && <EventsTab onDataChange={loadOverview} />}
        {tab === 'tokens'       && <TokensTab />}
        {tab === 'bornes'       && <BornesTab />}
        {tab === 'utilisateurs' && <UsersTab />}
        {tab === 'email'        && <EmailLogsTab />}
      </main>
    </div>
  );
}
