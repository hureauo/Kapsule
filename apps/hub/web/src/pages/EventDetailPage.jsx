import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, clearToken } from '../api/client.js';
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
        <h3 className="panel-section__title">Bornes d'essai</h3>
        {previewTokens.length === 0 && (
          <p className="text--muted">Aucune borne d'essai pour cet événement.</p>
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
  const TABS = ['Questions', 'Design', 'Synchro', 'Galerie', ...(previewTokens.length > 0 ? ['Aperçu'] : [])];

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
      </main>
    </div>
  );
}
