import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, clearToken } from '../api/client.js';
import { DEFAULTS } from '@kapsule/core';
import QuestionEditor from '../components/QuestionEditor.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import VideoGallery from '../components/VideoGallery.jsx';

const FROZEN_STATUSES = new Set(['live', 'closed', 'pushed', 'processed', 'purged']);

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR');
}

export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [tab, setTab] = useState('Questions');
  const [error, setError] = useState('');

  // Champs éditables
  const [consentText, setConsentText] = useState('');
  const [idleTimeout, setIdleTimeout] = useState(DEFAULTS.IDLE_TIMEOUT_S);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  async function loadEvent() {
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
  }

  useEffect(() => { loadEvent(); }, [id]);

  // Charger les meta RGPD depuis event_meta via le backend
  // Pour 2.6 on pré-remplit avec les valeurs par défaut ; l'éditeur les persiste via PUT /api/events/:id
  useEffect(() => {
    if (!event) return;
    // consent_text et idle_timeout ne sont pas dans le registre Hub — ils vivent dans event_meta
    // du db.sqlite de l'événement. On les expose via l'endpoint PUT uniquement pour l'instant.
    // Valeurs par défaut à l'affichage :
    setConsentText(DEFAULTS.CONSENT_TEXT);
    setIdleTimeout(DEFAULTS.IDLE_TIMEOUT_S);
  }, [event?.id]);

  async function handleSaveMeta(e) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');
    try {
      await api.updateEvent(id, { consent_text: consentText, idle_timeout: idleTimeout });
      setSaveMsg('Sauvegardé.');
      await loadEvent();
    } catch (err) {
      setSaveMsg(`Erreur : ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

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
  const TABS = ['Questions', 'Synchro', 'Galerie', ...(previewTokens.length > 0 ? ['Aperçu'] : [])];

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
        {/* Bandeaux de statut */}
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

        {/* Info + transitions de statut */}
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

        {/* Onglets */}
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

        {/* Contenu de l'onglet Questions */}
        {tab === 'Questions' && (
          <div className="tab-content">
            {/* Paramètres RGPD et timeout */}
            <section className="panel-section">
              <h3 className="panel-section__title">Paramètres de l'événement</h3>
              <form onSubmit={handleSaveMeta} className="meta-form">
                <label className="field-label">
                  Texte de consentement RGPD
                  <textarea
                    className="hub-input"
                    rows={4}
                    value={consentText}
                    onChange={(e) => setConsentText(e.target.value)}
                    disabled={frozen}
                  />
                </label>
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
                {!frozen && (
                  <button type="submit" className="btn btn--primary" disabled={saving}>
                    {saving ? 'Sauvegarde…' : 'Sauvegarder les paramètres'}
                  </button>
                )}
                {saveMsg && <p className="text--muted">{saveMsg}</p>}
              </form>
            </section>

            <section className="panel-section">
              <h3 className="panel-section__title">Questions</h3>
              <QuestionEditor eventId={id} frozen={frozen} />
            </section>
          </div>
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
          <div className="tab-content">
            <section className="panel-section">
              <h3 className="panel-section__title">Borne d'essai</h3>
              <p className="text--muted" style={{ marginBottom: '1rem' }}>
                Cette borne est en mode aperçu. Les données enregistrées ne seront pas envoyées.
              </p>
              {previewTokens.map(t => (
                <div key={t.id} className="preview-token-card">
                  <div><strong>{t.label || 'Borne d\'essai'}</strong>
                    {t.location && <span className="text--muted"> — {t.location}</span>}
                  </div>
                  {t.location && /^https?:\/\//.test(t.location) && (
                    <a
                      href={t.location}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn--primary"
                      style={{ marginTop: '0.5rem', display: 'inline-block' }}
                    >
                      Ouvrir l'aperçu ↗
                    </a>
                  )}
                  {!t.location && (
                    <p className="text--muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                      Renseignez le champ « location » du token avec l'URL de la borne d'essai pour accéder à l'aperçu.
                    </p>
                  )}
                </div>
              ))}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
