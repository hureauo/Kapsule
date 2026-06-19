import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, clearToken, getRole } from '../api/client.js';
import { DEFAULTS, THEMES, TEXT_FIELDS } from '@kapsule/core';
import QuestionEditor from '../components/QuestionEditor.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import VideoGallery from '../components/VideoGallery.jsx';

const FROZEN_STATUSES = new Set(['live', 'closed', 'pushed', 'processed', 'purged']);

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
      await api.updateEvent(event.id, { theme, idle_timeout: idleTimeout, ...texts });
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

        {!frozen && (
          <div style={{ marginTop: '8px' }}>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Sauvegarde…' : 'Sauvegarder le design'}
            </button>
          </div>
        )}
        {saveMsg && <p className="text--muted" style={{ marginTop: '8px' }}>{saveMsg}</p>}
      </form>
    </div>
  );
}

// ── Onglet Aperçu ─────────────────────────────────────────────────────────────
function ApercuTab({ event, previewTokens, onConfigImported }) {
  const [importState, setImportState] = useState(null); // null | 'loading' | { questions, meta } | 'error'
  const [importError, setImportError] = useState('');
  const [modal, setModal] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState('');

  // Preview auto-provisionnée
  const [previewStatus, setPreviewStatus] = useState(null); // null | { up, preview_url }
  const [generatedLink, setGeneratedLink] = useState('');
  const [linkExpiry, setLinkExpiry] = useState('7d');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    api.previewStatus(event.id)
      .then(s => setPreviewStatus(s))
      .catch(() => setPreviewStatus({ up: false, preview_url: null }));
  }, [event.id]);

  async function handleGenerateLink() {
    setLinkLoading(true);
    setGeneratedLink('');
    setLinkCopied(false);
    try {
      const { preview_url } = await api.generatePreviewToken(event.id, linkExpiry);
      setGeneratedLink(preview_url);
    } finally {
      setLinkLoading(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(generatedLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  // Borne preview avec une URL de location valide (point d'entrée pour lire la config)
  const previewBorne = previewTokens.find(t => t.location && /^https?:\/\//.test(t.location)) ?? null;

  async function fetchPreviewConfig() {
    if (!previewBorne) return;
    setImportState('loading');
    setImportError('');
    try {
      // Lit la config directement sur la borne preview (endpoints publics)
      const [eventRes, questionsRes] = await Promise.all([
        fetch(`${previewBorne.location}/api/event`),
        fetch(`${previewBorne.location}/api/questions`),
      ]);
      if (!eventRes.ok) throw new Error(`Borne preview inaccessible (${eventRes.status})`);
      const [eventData, questions] = await Promise.all([eventRes.json(), questionsRes.json()]);

      const meta = {
        theme: eventData.theme,
        idle_timeout: String(eventData.idle_timeout),
        welcome_title: eventData.welcome_title ?? '',
        welcome_subtitle: eventData.welcome_subtitle ?? '',
        name_prompt: eventData.name_prompt ?? '',
        consent_text: eventData.consent_text ?? '',
        consent_details: eventData.consent_details ?? '',
        thanks_text: eventData.thanks_text ?? '',
      };
      setImportState({ questions, meta });
      setModal(true);
    } catch (err) {
      setImportState('error');
      setImportError(err.message);
    }
  }

  async function applyConfig(mode) {
    setApplying(true);
    setApplyMsg('');
    try {
      await api.importPreviewConfig(event.id, { ...importState, mode });
      setApplyMsg('Configuration importée.');
      setModal(false);
      onConfigImported();
    } catch (err) {
      setApplyMsg(`Erreur : ${err.message}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="tab-content">
      <section className="panel-section">
        <h3 className="panel-section__title">Borne d'essai</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          {previewStatus === null && <span className="text--muted">Vérification…</span>}
          {previewStatus !== null && (
            <>
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                background: previewStatus.up ? '#22c55e' : '#ef4444',
              }} />
              <span className="text--muted">{previewStatus.up ? 'En ligne' : 'Hors ligne'}</span>
              {previewStatus.preview_url && (
                <a href={previewStatus.preview_url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost" style={{ padding: '2px 10px', fontSize: '0.85rem' }}>
                  Ouvrir ↗
                </a>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label className="text--muted" style={{ fontSize: '0.85rem' }}>Lien valide</label>
          <select value={linkExpiry} onChange={e => setLinkExpiry(e.target.value)} style={{ fontSize: '0.85rem', padding: '2px 6px' }}>
            <option value="1d">1 jour</option>
            <option value="7d">7 jours</option>
            <option value="30d">30 jours</option>
          </select>
          <button className="btn btn--primary" onClick={handleGenerateLink} disabled={linkLoading} style={{ padding: '4px 12px', fontSize: '0.85rem' }}>
            {linkLoading ? 'Génération…' : 'Générer un lien d\'accès'}
          </button>
        </div>
        {generatedLink && (
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <input readOnly value={generatedLink} style={{ flex: 1, minWidth: 200, fontSize: '0.8rem', padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4 }} />
            <button className="btn btn--ghost" onClick={copyLink} style={{ padding: '4px 10px', fontSize: '0.85rem' }}>
              {linkCopied ? 'Copié ✓' : 'Copier'}
            </button>
          </div>
        )}
      </section>

      <section className="panel-section">
        <h3 className="panel-section__title">Tokens manuels</h3>
        {previewTokens.length === 0 && (
          <p className="text--muted">Aucun token d'essai pour cet événement.</p>
        )}
        {previewTokens.map(t => (
          <div key={t.id} className="preview-token-card">
            <div>
              <strong>{t.label || "Borne d'essai"}</strong>
              {t.location && <span className="text--muted"> — {t.location}</span>}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
              {t.location && /^https?:\/\//.test(t.location) && (
                <a href={t.location} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
                  Ouvrir ↗
                </a>
              )}
            </div>
            {!t.location && (
              <p className="text--muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                Renseignez le champ « location » du token avec l'URL de la borne d'essai pour activer l'import.
              </p>
            )}
          </div>
        ))}
      </section>

      {previewBorne && (
        <section className="panel-section">
          <h3 className="panel-section__title">Importer la configuration de la preview</h3>
          <p className="text--muted" style={{ marginBottom: '12px', fontSize: '14px' }}>
            Récupère les questions et le design tels que configurés sur la borne d'essai,
            et les applique à cet événement. Les vidéos ne sont jamais transférées.
          </p>
          <button
            className="btn btn--primary"
            onClick={fetchPreviewConfig}
            disabled={importState === 'loading'}
          >
            {importState === 'loading' ? 'Récupération…' : 'Importer la config de la preview'}
          </button>
          {importState === 'error' && (
            <p className="text--error" style={{ marginTop: '8px' }}>{importError}</p>
          )}
          {applyMsg && <p className="text--muted" style={{ marginTop: '8px' }}>{applyMsg}</p>}
        </section>
      )}

      {modal && importState && importState !== 'loading' && importState !== 'error' && (
        <div className="modal-overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal__title">Importer la config de la preview</h3>
            <div className="modal__body">
              <p style={{ marginBottom: '8px' }}>
                <strong>{importState.questions?.length ?? 0} question(s)</strong> +{' '}
                thème <strong>{importState.meta?.theme ?? '?'}</strong> récupérés depuis la borne d'essai.
              </p>
              <p className="text--muted" style={{ fontSize: '13px', marginBottom: '16px' }}>
                Choisissez comment appliquer ces données à l'événement :
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button
                  className="btn btn--primary"
                  onClick={() => applyConfig('overwrite')}
                  disabled={applying}
                >
                  Écraser — remplacer questions + design par ceux de la preview
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => applyConfig('merge')}
                  disabled={applying}
                >
                  Fusionner — garder les champs Hub non vides déjà définis
                </button>
                <button className="btn btn--ghost" onClick={() => setModal(false)} disabled={applying}>
                  Annuler
                </button>
              </div>
              {applyMsg && <p className="text--muted" style={{ marginTop: '8px' }}>{applyMsg}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
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

// ── Page principale ───────────────────────────────────────────────────────────
export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [tab, setTab] = useState('Questions');
  const [error, setError] = useState('');

  const loadEvent = useCallback(async () => {
    try {
      const [ev, syncInfo] = await Promise.all([
        api.getEvent(id),
        api.getSyncInfo(id).catch(() => ({ tokens: [] })),
      ]);
      setEvent(ev);
      setTokens(syncInfo.tokens ?? []);
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
  const previewTokens = tokens.filter(t => t.is_preview);
  const isSuperuser = getRole() === 'superuser';
  const TABS = [
    'Questions', 'Design', 'Synchro', 'Galerie',
    'Aperçu',
    ...(isSuperuser ? ['Utilisateurs'] : []),
  ];

  return (
    <div className="hub-page">
      <header className="hub-header">
        <Link to="/events" className="btn btn--ghost">← Événements</Link>
        <span className="hub-header__title">{event.name}</span>
        <button className="btn btn--ghost" onClick={() => { clearToken(); navigate('/login', { replace: true }); }}>
          Déconnexion
        </button>
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

        <section className="event-meta-section">
          <div className="event-meta-row">
            <span className="text--muted">Date : {formatDate(event.event_date)}</span>
            <span className={`status-badge status-badge--${event.status}`}>{event.status}</span>
          </div>
          {!frozen && (
            <div className="event-meta-row">
              {event.status === 'draft' && (
                <button className="btn btn--primary" onClick={() => handleStatusChange('ready')}>
                  Marquer prêt
                </button>
              )}
              {event.status === 'ready' && (
                <button className="btn btn--ghost" onClick={() => handleStatusChange('draft')}>
                  Repasser en brouillon
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
            {!['pushed', 'processed'].includes(event.status) ? (
              <p className="text--muted">La galerie est disponible après le push de la borne.</p>
            ) : (
              <VideoGallery eventId={id} eventName={event.name} />
            )}
          </div>
        )}

        {tab === 'Aperçu' && (
          <ApercuTab
            event={event}
            previewTokens={previewTokens}
            onConfigImported={loadEvent}
          />
        )}

        {tab === 'Utilisateurs' && isSuperuser && (
          <UtilisateursTab eventId={id} />
        )}
      </main>
    </div>
  );
}
