import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, clearToken, getRole } from '../api/client.js';
import { DEFAULTS, THEMES, TEXT_FIELDS, VIDEO_QUALITY, DEFAULT_VIDEO_QUALITY, mbPerMinFromKey } from '@kapsule/core';
import QuestionEditor from '../components/QuestionEditor.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import VideoGallery from '../components/VideoGallery.jsx';
import PreviewGallery from '../components/PreviewGallery.jsx';

const FROZEN_STATUSES = new Set(['live', 'closed', 'pushed', 'processed', 'waiting']);

const STATUS_LABEL = {
  draft: 'Brouillon', preview: 'Preview', ready: 'Prêt', loaded: 'Chargé',
  live: 'En cours', closed: 'Terminé', pushed: 'Poussé',
  processed: 'Traité', waiting: 'En attente',
};

const THEME_OPTIONS = [
  { value: 'cute',   label: '🫧 Cutealism', hint: 'Doux, coloré, rassurant (défaut)' },
  { value: 'modern', label: '⬜ Modern',    hint: 'Blanc épuré, plat, léger' },
  { value: 'dark',   label: '🎬 Sombre',    hint: 'Noir / rouge, sobre' },
];

const TEXT_FIELD_LABELS = {
  welcome_title:    "Titre d'accueil",
  welcome_subtitle: "Sous-titre d'accueil",
  name_prompt:      'Invite prénom',
  consent_text:     'Texte de consentement RGPD',
  consent_details:  'Détails (« En savoir plus »)',
  thanks_text:      'Message de remerciement',
};

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR');
}

function getMeta(event, key, fallback = '') {
  return event?.meta?.[key] ?? fallback;
}

// ── Onglet Design ─────────────────────────────────────────────────────────────

function DesignTab({ event, frozen, onSaved }) {
  const meta = event?.meta ?? {};
  const [theme, setTheme] = useState(meta.theme ?? DEFAULTS.THEME);
  const [videoQuality, setVideoQuality] = useState(meta.video_quality ?? DEFAULT_VIDEO_QUALITY);
  const [texts, setTexts] = useState(() => {
    const t = {};
    for (const key of Object.keys(TEXT_FIELDS)) t[key] = meta[key] ?? '';
    return t;
  });
  const [idleTimeout, setIdleTimeout] = useState(
    parseInt(meta.idle_timeout ?? String(DEFAULTS.IDLE_TIMEOUT_S), 10)
  );
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Resync si l'event est rechargé de l'extérieur
  useEffect(() => {
    const m = event?.meta ?? {};
    setTheme(m.theme ?? DEFAULTS.THEME);
    setVideoQuality(m.video_quality ?? DEFAULT_VIDEO_QUALITY);
    const t = {};
    for (const key of Object.keys(TEXT_FIELDS)) t[key] = m[key] ?? '';
    setTexts(t);
    setIdleTimeout(parseInt(m.idle_timeout ?? String(DEFAULTS.IDLE_TIMEOUT_S), 10));
  }, [event?.id, event?.updated_at]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');
    try {
      await api.updateEvent(event.id, { theme, idle_timeout: idleTimeout, video_quality: videoQuality, ...texts });
      setSaveMsg('Sauvegardé.');
      onSaved();
    } catch (err) {
      setSaveMsg(`Erreur : ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tab-content">
      <form onSubmit={handleSave}>
        {!frozen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Sauvegarde…' : 'Sauvegarder le design'}
            </button>
            {saveMsg && <span className="text--muted" style={{ fontSize: '13px' }}>{saveMsg}</span>}
          </div>
        )}
        <section className="panel-section">
          <h3 className="panel-section__title">Thème visuel</h3>
          <div className="theme-picker">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`theme-option${theme === opt.value ? ' theme-option--active' : ''}`}
                onClick={() => !frozen && setTheme(opt.value)}
                disabled={frozen}
                aria-pressed={theme === opt.value}
              >
                <span className="theme-option__label">{opt.label}</span>
                <span className="theme-option__hint">{opt.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <h3 className="panel-section__title">Qualité vidéo</h3>
          <label className="field-label">
            Preset d'enregistrement
            <select
              className="hub-input hub-input--sm"
              value={videoQuality}
              onChange={(e) => setVideoQuality(e.target.value)}
              disabled={frozen}
            >
              {Object.entries(VIDEO_QUALITY).map(([key, q]) => (
                <option key={key} value={key}>{q.label} — {q.width}×{q.height} · {(q.videoBitrate / 1e6).toFixed(1)} Mbps</option>
              ))}
            </select>
          </label>
          <p className="text--muted" style={{ fontSize: '13px', marginTop: '6px' }}>
            ≈ {mbPerMinFromKey(videoQuality)} Mo/min par vidéo
            {VIDEO_QUALITY[videoQuality] && ` · résolution ${VIDEO_QUALITY[videoQuality].width}×${VIDEO_QUALITY[videoQuality].height}`}
          </p>
        </section>

        <section className="panel-section">
          <h3 className="panel-section__title">Textes du parcours invité</h3>
          {Object.entries(TEXT_FIELD_LABELS).map(([key, label]) => (
            <label key={key} className="field-label">
              {label}
              <textarea
                className="hub-input"
                rows={key === 'consent_text' || key === 'consent_details' ? 4 : 2}
                value={texts[key] ?? ''}
                onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
                disabled={frozen}
                placeholder={TEXT_FIELDS[key] || '(défaut)'}
              />
            </label>
          ))}
        </section>

        <section className="panel-section">
          <h3 className="panel-section__title">Paramètres</h3>
          <label className="field-label">
            Timeout d'inactivité (secondes)
            <input
              type="number"
              className="hub-input hub-input--sm"
              min={30}
              max={600}
              value={idleTimeout}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setIdleTimeout(v); }}
              disabled={frozen}
            />
          </label>
        </section>

      </form>
    </div>
  );
}

// ── Box borne d'essai (haut de page) ──────────────────────────────────────────
// Box d'état de la borne d'essai, affichée en haut de la page événement.
function PreviewBox({ event }) {
  const [status, setStatus] = useState(null); // { up, preview_url } | null pendant le chargement

  useEffect(() => {
    api.previewStatus(event.id)
      .then(setStatus)
      .catch(() => setStatus({ up: false, preview_url: null }));
  }, [event.id]);

  return (
    <section className="event-meta-section">
      <div className="event-meta-row" style={{ gap: '10px', flexWrap: 'wrap' }}>
        <span className="panel-section__title" style={{ margin: 0 }}>Borne d'essai</span>
        {status === null
          ? <span className="text--muted" style={{ fontSize: '14px' }}>Vérification…</span>
          : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}>
              <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: status.up ? '#16a34a' : '#9ca3af' }} />
              {status.up ? 'En ligne' : 'Hors ligne'}
            </span>
          )
        }
        {status?.up && status.preview_url && (
          <a href={status.preview_url} target="_blank" rel="noopener noreferrer" className="btn btn--primary btn--sm">
            Ouvrir la borne d'essai ↗
          </a>
        )}
      </div>
      {status && !status.up && (
        <p className="text--muted" style={{ fontSize: '13px', marginTop: '6px' }}>
          La borne d'essai n'est pas démarrée. Un administrateur peut la lancer depuis le panneau d'administration.
        </p>
      )}
    </section>
  );
}

// ── Onglet Utilisateurs ───────────────────────────────────────────────────────
const BORNE_ROLES = ['admin_borne', 'tech_borne', 'general'];
const BORNE_ROLE_LABELS = { admin_borne: 'Admin borne', tech_borne: 'Technicien', general: 'Invité (general)' };

function UtilisateursTab({ eventId }) {
  const [eventUsers, setEventUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [eu, all] = await Promise.all([api.listEventUsers(eventId), api.listUsers()]);
      setEventUsers(eu);
      setAllUsers(all);
    } catch (err) {
      setError(err.message);
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const assignedIds = new Set(eventUsers.map(u => String(u.user_id)));
  const available = allUsers.filter(u => !assignedIds.has(String(u.id)) && u.active);

  function toggleRole(role) {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!selectedUserId || selectedRoles.length === 0) return;
    setAdding(true);
    setMsg('');
    setError('');
    try {
      await api.addEventUser(eventId, Number(selectedUserId), selectedRoles);
      setSelectedUserId('');
      setSelectedRoles([]);
      setMsg('Utilisateur ajouté.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId) {
    setMsg('');
    setError('');
    try {
      await api.removeEventUser(eventId, userId);
      setMsg('Utilisateur retiré.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="tab-content">
      <section className="panel-section">
        <h3 className="panel-section__title">Utilisateurs assignés</h3>
        {eventUsers.length === 0 && <p className="text--muted">Aucun utilisateur assigné.</p>}
        {eventUsers.map(u => (
          <div key={u.user_id} className="user-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <div style={{ flex: 1 }}>
              <strong>{u.email}</strong>
              {u.name && <span className="text--muted"> ({u.name})</span>}
              <span style={{ marginLeft: '8px', fontSize: '0.8rem', color: 'var(--color-muted)' }}>
                {u.roles.map(r => BORNE_ROLE_LABELS[r] ?? r).join(', ')}
              </span>
            </div>
            <button className="btn btn--ghost" onClick={() => handleRemove(u.user_id)}>
              Retirer
            </button>
          </div>
        ))}
      </section>

      <section className="panel-section">
        <h3 className="panel-section__title">Ajouter un utilisateur</h3>
        {available.length === 0 ? (
          <p className="text--muted">Tous les comptes actifs sont déjà assignés.</p>
        ) : (
          <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '480px' }}>
            <label className="field-label">
              Compte
              <select
                className="hub-input"
                value={selectedUserId}
                onChange={e => setSelectedUserId(e.target.value)}
                required
              >
                <option value="">— choisir —</option>
                {available.map(u => (
                  <option key={u.id} value={u.id}>{u.email}{u.name ? ` (${u.name})` : ''}</option>
                ))}
              </select>
            </label>
            <fieldset style={{ border: '1px solid var(--color-border)', borderRadius: '6px', padding: '12px' }}>
              <legend style={{ padding: '0 6px', fontSize: '0.85rem' }}>Rôles sur la borne</legend>
              {BORNE_ROLES.map(role => (
                <label key={role} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  {BORNE_ROLE_LABELS[role]}
                </label>
              ))}
            </fieldset>
            <button type="submit" className="btn btn--primary" disabled={adding || !selectedUserId || selectedRoles.length === 0}>
              {adding ? 'Ajout…' : 'Assigner'}
            </button>
          </form>
        )}
        {msg && <p className="text--muted" style={{ marginTop: '8px' }}>{msg}</p>}
        {error && <p className="text--error" style={{ marginTop: '8px' }}>{error}</p>}
      </section>
    </div>
  );
}

// ── Onglet Historique ─────────────────────────────────────────────────────────

const DIFF_TYPE_LABELS = {
  questions_added:     (d) => `+ ${d.items.length} question(s) ajoutée(s)`,
  questions_removed:   (d) => `- ${d.items.length} question(s) supprimée(s)`,
  questions_modified:  (d) => `${d.items.length} question(s) modifiée(s)`,
  questions_reordered: ()  => 'Questions réordonnées',
  meta_changed: (d) => {
    const labels = { theme: 'Thème', idle_timeout: "Délai d'inactivité", welcome_title: "Titre d'accueil", welcome_subtitle: 'Sous-titre', name_prompt: 'Invite nom', consent_text: 'Texte consentement', consent_details: 'Détails consentement', thanks_text: 'Message de remerciement' };
    return `${labels[d.key] ?? d.key} : ${d.before ?? '∅'} → ${d.after ?? '∅'}`;
  },
};

function VersionBlock({ version, eventId, isSuperuser, onRestored }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [restoring, setRestoring] = useState(false);

  async function load() {
    if (detail) { setOpen(o => !o); return; }
    const data = await api.getVersion(eventId, version.id);
    setDetail(data);
    setOpen(true);
  }

  async function restore() {
    if (!confirm('Restaurer cette version ? L\'état actuel sera remplacé.')) return;
    setRestoring(true);
    try {
      await api.restoreVersion(eventId, version.id);
      onRestored();
    } catch (err) {
      alert(`Erreur : ${err.message}`);
    } finally {
      setRestoring(false);
    }
  }

  const date = new Date(version.created_at.endsWith('Z') ? version.created_at : version.created_at + 'Z');
  const dateStr = `${date.getDate().toString().padStart(2,'0')}/${(date.getMonth()+1).toString().padStart(2,'0')} ${date.getHours().toString().padStart(2,'0')}h${date.getMinutes().toString().padStart(2,'0')}`;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
      <button
        onClick={load}
        style={{ width: '100%', background: 'none', border: 'none', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{dateStr}</span>
        <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{version.summary}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && detail && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid var(--border)' }}>
          {version.author && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Par : <strong>{version.author}</strong>
            </p>
          )}
          {detail.diff.length === 0
            ? <p className="text--muted" style={{ fontSize: 13, marginTop: 8 }}>Aucun changement détecté.</p>
            : (
              <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px', fontSize: 13 }}>
                {detail.diff.map((d, i) => (
                  <li key={i} style={{ marginBottom: 4, color: d.type === 'questions_added' ? '#16a34a' : d.type === 'questions_removed' ? '#dc2626' : 'inherit' }}>
                    {DIFF_TYPE_LABELS[d.type]?.(d) ?? d.type}
                    {(d.type === 'questions_added' || d.type === 'questions_removed' || d.type === 'questions_modified') && d.items && (
                      <ul style={{ marginTop: 2, paddingLeft: 14, color: 'var(--text-muted)' }}>
                        {d.items.map((item, j) => <li key={j} style={{ fontSize: 12 }}>{item}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
          {isSuperuser && (
            <button className="btn btn--ghost btn--sm" style={{ marginTop: 10 }} onClick={restore} disabled={restoring}>
              {restoring ? 'Restauration…' : 'Restaurer cette version'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HistoriqueTab({ event, isSuperuser, onRestored }) {
  const [versions, setVersions] = useState(null);

  useEffect(() => {
    api.listVersions(event.id).then(setVersions).catch(() => setVersions([]));
  }, [event.id]);

  return (
    <div className="tab-content">
      <section className="panel-section">
        <h3 className="panel-section__title">Historique des modifications</h3>
        {versions === null && <p className="text--muted">Chargement…</p>}
        {versions?.length === 0 && <p className="text--muted">Aucune modification enregistrée.</p>}
        {versions?.map(v => (
          <VersionBlock
            key={v.id}
            version={v}
            eventId={event.id}
            isSuperuser={isSuperuser}
            onRestored={onRestored}
          />
        ))}
      </section>
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────
export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [tab, setTab] = useState('Questions');
  const [error, setError] = useState('');

  const loadEvent = useCallback(async () => {
    try {
      const ev = await api.getEvent(id);
      setEvent(ev);
    } catch (err) {
      if (err.status === 401) { clearToken(); navigate('/login', { replace: true }); }
      else setError(err.message);
    }
  }, [id]);

  useEffect(() => { loadEvent(); }, [loadEvent]);

  async function handleStatusChange(status) {
    try {
      await api.setEventStatus(id, status);
      await loadEvent();
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <div className="hub-page"><p className="error-msg">{error}</p></div>;
  if (!event) return <div className="hub-page"><p className="text--muted">Chargement…</p></div>;

  const frozen = FROZEN_STATUSES.has(event.status);
  const notYetPulled = event.pulled_at && event.updated_at > event.pulled_at;
  const isSuperuser = getRole() === 'superuser';
  const TABS = [
    'Questions', 'Design', 'Synchro', 'Galerie',
    'Historique',
    ...(isSuperuser ? ['Utilisateurs'] : []),
  ];

  return (
    <div className="hub-page">
      <header className="hub-header">
        <Link to="/events" className="btn btn--ghost">← Événements</Link>
        <span className="hub-header__title">{event.name}</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {isSuperuser && (
            <button className="btn btn--ghost" onClick={() => navigate('/admin')}>Administration</button>
          )}
          <button className="btn btn--ghost" onClick={() => { clearToken(); navigate('/login', { replace: true }); }}>
            Déconnexion
          </button>
        </div>
      </header>

      <main className="hub-main">
        {frozen && (
          <div className="banner banner--warn">
            Lecture seule — événement en cours sur la borne ({event.status})
          </div>
        )}
        {!frozen && notYetPulled && (
          <div className="banner banner--info">
            Modifications non encore récupérées par la borne
          </div>
        )}

        <PreviewBox event={event} />

        <section className="event-meta-section">
          <div className="event-meta-row">
            <span className="text--muted">Date : {formatDate(event.event_date)}</span>
            <span className={`status-badge status-badge--${event.status}`}>
              {STATUS_LABEL[event.status] ?? event.status}
            </span>
          </div>
          {!frozen && (
            <div className="event-meta-row" style={{ gap: '8px', flexWrap: 'wrap' }}>
              {event.status === 'draft' && (
                <button className="btn btn--primary" onClick={() => handleStatusChange('preview')}>
                  Lancer la preview
                </button>
              )}
              {event.status === 'preview' && (<>
                <button className="btn btn--ghost" onClick={() => handleStatusChange('draft')}>
                  Repasser en brouillon
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    if (confirm('Valider la configuration ? Le contenu (questions, design) sera gelé et la borne réelle pourra se connecter.')) {
                      handleStatusChange('ready');
                    }
                  }}
                >
                  Valider la configuration
                </button>
              </>)}
              {event.status === 'ready' && (
                <button className="btn btn--ghost" onClick={() => handleStatusChange('preview')}>
                  Retour en preview
                </button>
              )}
            </div>
          )}
        </section>

        <div className="hub-tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`hub-tab${tab === t ? ' hub-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Questions' && (
          <div className="tab-content">
            <section className="panel-section">
              <h3 className="panel-section__title">Questions</h3>
              <QuestionEditor eventId={id} frozen={frozen} />
            </section>
          </div>
        )}

        {tab === 'Design' && (
          <DesignTab event={event} frozen={frozen} onSaved={loadEvent} />
        )}

        {tab === 'Synchro' && (
          <div className="tab-content">
            <SyncStatus event={event} />
          </div>
        )}

        {tab === 'Galerie' && (
          <div className="tab-content">
            {event.status === 'draft' ? (
              // Pas encore de borne lancée — rien à afficher
              <p className="text--muted">
                La galerie est disponible une fois l'événement en preview ou après le push de la borne.
              </p>
            ) : event.status === 'preview' ? (
              // Borne d'essai active : galerie proxifiée depuis le container preview
              <PreviewGallery eventId={id} />
            ) : ['ready', 'loaded'].includes(event.status) ? (
              // Borne d'essai arrêtée (preview → ready) : les vidéos de test ne sont plus accessibles
              <p className="text--muted">
                La borne d'essai a été arrêtée lors du passage en état « Prêt ». Les vidéos enregistrées
                pendant la preview ne sont pas conservées — elles serviront uniquement à valider la configuration.
                La galerie définitive sera disponible après le push de la borne réelle.
              </p>
            ) : (
              // Post-push : galerie Hub classique (vidéos dans DATA_DIR Hub)
              <VideoGallery eventId={id} eventName={event.name} />
            )}
          </div>
        )}

        {tab === 'Historique' && (
          <HistoriqueTab event={event} isSuperuser={isSuperuser} onRestored={loadEvent} />
        )}

        {tab === 'Utilisateurs' && isSuperuser && (
          <UtilisateursTab eventId={id} />
        )}
      </main>
    </div>
  );
}
