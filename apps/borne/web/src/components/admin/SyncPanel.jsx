import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

const POLL_MS = 2000;

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR');
}

// Retourne 'equal' | 'different' | 'unknown' en comparant questions + meta Hub vs local
function diffConfig(hub, local) {
  if (!hub || !local) return 'unknown';
  const hubQ = JSON.stringify(hub.questions.map(q => ({ text: q.text, max_duration: q.max_duration, countdown: q.countdown, enabled: q.enabled })));
  const locQ = JSON.stringify(local.questions.map(q => ({ text: q.text, max_duration: q.max_duration, countdown: q.countdown, enabled: q.enabled })));
  const META_KEYS = ['theme', 'idle_timeout', 'welcome_title', 'welcome_subtitle', 'name_prompt', 'consent_text', 'consent_details', 'thanks_text'];
  const pick = (meta) => Object.fromEntries(META_KEYS.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
  if (hubQ !== locQ) return 'different';
  if (JSON.stringify(pick(hub.meta)) !== JSON.stringify(pick(local.meta))) return 'different';
  return 'equal';
}

export default function SyncPanel() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [hubConfig, setHubConfig] = useState(null);

  // États de feedback des actions
  const [pullState, setPullState] = useState(null);   // null | 'loading' | 'ok' | 'error'
  const [pullMsg, setPullMsg] = useState('');
  const [pushConfigState, setPushConfigState] = useState(null);
  const [pushConfigMsg, setPushConfigMsg] = useState('');
  const [pushError, setPushError] = useState('');

  // Gestion du token
  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenState, setTokenState] = useState(null);  // null | 'loading' | 'ok' | 'error'
  const [tokenMsg, setTokenMsg] = useState('');

  // Refresh
  const [refreshing, setRefreshing] = useState(false);

  // Purge
  const [purgeEventId, setPurgeEventId] = useState(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purgeMsg, setPurgeMsg] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getSyncStatus();
      setStatus(s);
    } catch { /* non bloquant */ }
  }, []);

  const loadEvents = useCallback(async () => {
    try { setEvents(await api.listEvents()); } catch { /* non bloquant */ }
  }, []);

  const loadHubConfig = useCallback(async () => {
    try {
      const h = await api.getHubConfig();
      setHubConfig(h);
    } catch {
      setHubConfig(null);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadEvents();
    loadHubConfig();
    const id = setInterval(loadStatus, POLL_MS);
    return () => clearInterval(id);
  }, [loadStatus, loadEvents, loadHubConfig]);

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([loadStatus(), loadHubConfig()]);
    setRefreshing(false);
  }

  async function handlePull() {
    setPullState('loading');
    setPullMsg('');
    try {
      const res = await api.triggerPull();
      await Promise.all([loadStatus(), loadEvents(), loadHubConfig()]);
      setPullState('ok');
      setPullMsg(res.pulled ? 'Config récupérée depuis le Hub.' : 'Déjà à jour — aucune modification.');
    } catch (err) {
      setPullState('error');
      setPullMsg(err.message);
    }
  }

  async function handlePushConfig() {
    setPushConfigState('loading');
    setPushConfigMsg('');
    try {
      await api.triggerPushConfig();
      await loadHubConfig();
      setPushConfigState('ok');
      setPushConfigMsg('Config envoyée au Hub.');
    } catch (err) {
      setPushConfigState('error');
      setPushConfigMsg(err.message);
    }
  }

  async function handleTokenSave() {
    if (!tokenInput.trim()) return;
    setTokenState('loading');
    setTokenMsg('');
    try {
      await api.updateToken(tokenInput.trim());
      await loadStatus();
      await loadHubConfig();
      setTokenState('ok');
      setTokenMsg('Token mis à jour.');
      setTokenEditing(false);
      setTokenInput('');
    } catch (err) {
      setTokenState('error');
      setTokenMsg(err.message);
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
  const diff = diffConfig(hubConfig, status?.localConfig);

  return (
    <div className="sync-panel">
      <h2 className="panel-title">Synchronisation Hub</h2>

      {/* ── Section 1 : Connexion ── */}
      <section className="panel-section">
        <h3 className="panel-section__title">Connexion Hub</h3>

        <div className="sync-row">
          <span className={`sync-badge${status?.online ? ' sync-badge--online' : ' sync-badge--offline'}`}>
            {status?.online ? 'En ligne' : 'Hors ligne'}
          </span>
          {status?.isPreview && (
            <span className="sync-badge sync-badge--preview">APERÇU</span>
          )}
          {status?.hubUrl && (
            <span className="text--muted sync-url">{status.hubUrl}</span>
          )}
        </div>

        <div className="sync-token-row">
          <span className="text--muted">Token : </span>
          {tokenEditing ? (
            <div className="sync-token-edit">
              <input
                className="admin-input admin-input--small"
                type="text"
                placeholder="Nouveau token…"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleTokenSave()}
                autoFocus
              />
              <button
                className="btn btn--primary btn--small"
                onClick={handleTokenSave}
                disabled={tokenState === 'loading' || !tokenInput.trim()}
              >
                {tokenState === 'loading' ? '…' : 'Sauvegarder'}
              </button>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => { setTokenEditing(false); setTokenInput(''); setTokenMsg(''); setTokenState(null); }}
              >
                Annuler
              </button>
            </div>
          ) : (
            <div className="sync-token-display">
              <code className="sync-token-value">{status?.token ?? '—'}</code>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => setTokenEditing(true)}
              >
                Changer
              </button>
            </div>
          )}
        </div>
        {tokenMsg && (
          <p className={tokenState === 'error' ? 'error-msg' : 'text--muted'}>{tokenMsg}</p>
        )}
      </section>

      {/* ── Section 2 : Config ── */}
      <section className="panel-section">
        <h3 className="panel-section__title">Configuration</h3>

        <div className="sync-config-grid">
          <div className="sync-config-col">
            <p className="sync-config-label">Hub</p>
            {hubConfig ? (
              <>
                <p className="text--muted">{hubConfig.questions.length} question{hubConfig.questions.length !== 1 ? 's' : ''}</p>
                <p className="text--muted">Thème : {hubConfig.meta?.theme ?? '—'}</p>
                <p className="text--muted sync-hash" title="Hash de la config Hub"><code>{hubConfig.hash ?? '—'}…</code></p>
              </>
            ) : (
              <p className="text--muted">{status?.online ? 'Non chargé' : 'Hors ligne'}</p>
            )}
          </div>
          <div className="sync-config-divider">
            {diff === 'equal' && <span className="sync-diff sync-diff--equal" title="Identique">✓</span>}
            {diff === 'different' && <span className="sync-diff sync-diff--different" title="Différent">≠</span>}
            {diff === 'unknown' && <span className="sync-diff" title="Inconnu">?</span>}
          </div>
          <div className="sync-config-col">
            <p className="sync-config-label">Local</p>
            {status?.localConfig ? (
              <>
                <p className="text--muted">{status.localConfig.questions.length} question{status.localConfig.questions.length !== 1 ? 's' : ''}</p>
                <p className="text--muted">Thème : {status.localConfig.meta?.theme ?? '—'}</p>
                <p className="text--muted sync-hash" title="Hash de la config locale"><code>{status.localConfig.hash ?? '—'}…</code></p>
              </>
            ) : (
              <p className="text--muted">Aucun événement actif</p>
            )}
          </div>
        </div>

        {diff === 'different' && (
          <p className="text--warn sync-diff-warn">
            La config locale et la config Hub diffèrent. Pull pour récupérer le Hub, Push pour envoyer le local.
          </p>
        )}

        <div className="sync-meta-row">
          <span className="text--muted">Dernier pull : {formatDate(status?.lastPull)}</span>
          <button
            className="btn btn--ghost btn--small"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Actualiser les hashs sans pull"
          >
            {refreshing ? '…' : '↺ Actualiser'}
          </button>
        </div>

        <div className="sync-actions">
          <button
            className={`btn btn--small${pullState === 'loading' ? ' btn--loading' : ' btn--secondary'}`}
            onClick={handlePull}
            disabled={!status?.online || pullState === 'loading'}
          >
            {pullState === 'loading' ? 'Pull…' : '↓ Pull (Hub → borne)'}
          </button>
          <button
            className={`btn btn--small${pushConfigState === 'loading' ? ' btn--loading' : ' btn--secondary'}`}
            onClick={handlePushConfig}
            disabled={!status?.online || pushConfigState === 'loading'}
          >
            {pushConfigState === 'loading' ? 'Push…' : '↑ Push config (borne → Hub)'}
          </button>
        </div>

        {pullMsg && (
          <p className={pullState === 'error' ? 'error-msg' : 'text--muted sync-feedback'}>{pullMsg}</p>
        )}
        {pushConfigMsg && (
          <p className={pushConfigState === 'error' ? 'error-msg' : 'text--muted sync-feedback'}>{pushConfigMsg}</p>
        )}
      </section>

      {/* ── Section 3 : Push vidéos ── */}
      <section className="panel-section">
        <h3 className="panel-section__title">Push vidéos vers le Hub</h3>

        {status?.isPreview && (
          <p className="text--muted">Push vidéos désactivé en mode aperçu.</p>
        )}

        {!status?.isPreview && (
          <>
            {!push.running && (push.lastError || pushError) && (
              <p className="error-msg">{push.lastError?.message || pushError}</p>
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
          </>
        )}
      </section>

      {/* ── Section 4 : Purge RGPD ── */}
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
