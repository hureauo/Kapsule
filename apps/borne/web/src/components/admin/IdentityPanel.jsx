import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';

const TOKEN_KIND_LABEL = {
  borne: 'Token de borne (machine)',
  event: 'Token d\'événement (essai / legacy)',
};

// Onglet Identité de la console /borne (Phase B). Reprend l'édition de token
// qui vivait dans SyncPanel — même interaction (masqué + « Changer »), mais
// centrée sur l'identité de la machine plutôt que sur la synchro.
//
// Nom/lieu de la borne (déclarés côté Hub, table `bornes`) ne sont pas encore
// remontés ici — nécessiterait un aller-retour Hub dédié, hors périmètre de
// ce sous-lot. En attendant, ces infos restent consultables depuis l'onglet
// Bornes du Hub.
export default function IdentityPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenState, setTokenState] = useState(null); // null | 'loading' | 'ok' | 'error'
  const [tokenMsg, setTokenMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await api.getSyncStatus());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleTokenSave() {
    if (!tokenInput.trim()) return;
    setTokenState('loading');
    setTokenMsg('');
    try {
      await api.updateToken(tokenInput.trim());
      await load();
      setTokenState('ok');
      setTokenMsg('Token mis à jour.');
      setTokenEditing(false);
      setTokenInput('');
    } catch (err) {
      setTokenState('error');
      setTokenMsg(err.message);
    }
  }

  if (error) return (
    <p className="text--error">
      {error}{' '}
      <button className="btn btn--small btn--secondary" onClick={load}>Réessayer</button>
    </p>
  );
  if (!status) return <p className="text--muted">Chargement…</p>;

  return (
    <div className="identity-panel">
      <section className="panel-section">
        <h2 className="panel-section__title">Connexion Hub</h2>
        <div className="sync-row">
          <span className={`sync-badge${status.online ? ' sync-badge--online' : ' sync-badge--offline'}`}>
            {status.online ? 'En ligne' : 'Hors ligne'}
          </span>
          {status.isPreview && (
            <span className="sync-badge sync-badge--preview">APERÇU</span>
          )}
        </div>
        <p className="text--muted" style={{ marginTop: '8px' }}>
          URL du Hub : <code>{status.hubUrl ?? '—'}</code>
        </p>
      </section>

      <section className="panel-section">
        <h2 className="panel-section__title">{TOKEN_KIND_LABEL[status.tokenKind] ?? 'Token'}</h2>

        {tokenEditing ? (
          <div className="sync-token-edit">
            <input
              className="admin-input admin-input--small"
              type="text"
              placeholder="Nouveau token…"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleTokenSave()}
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
            <code className="sync-token-value">{status.token ?? '—'}</code>
            <button className="btn btn--ghost btn--small" onClick={() => setTokenEditing(true)}>
              Changer
            </button>
          </div>
        )}
        {status.tokenKind === 'borne' && (
          <p className="text--muted" style={{ fontSize: '13px', marginTop: '4px' }}>
            Rotation persistée — survit à un redémarrage du container.
          </p>
        )}
        {tokenMsg && (
          <p className={tokenState === 'error' ? 'error-msg' : 'text--muted'}>{tokenMsg}</p>
        )}
      </section>
    </div>
  );
}
