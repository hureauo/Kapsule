import React, { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

// Écran affiché sur /borne tant qu'aucun token n'est configuré sur la borne
// (Phase C) — avant appairage, rien de sensible n'existe encore ici, donc pas
// de mot de passe requis : le technicien voit juste la progression sans avoir
// à s'authentifier. Une fois BORNE_TOKEN renseigné (redémarrage du conteneur),
// le parent (BornePage) bascule automatiquement vers le login normal.
const LEVEL_COLOR = { info: 'var(--color-muted)', error: '#dc2626' };

// onSkip : quitte l'onboarding pour le login TECH_PASSWORD (mode 100% autonome —
// sans HUB_URL, aucun appairage n'est prévu, l'onboarding resterait sinon un
// cul-de-sac permanent puisque hasToken ne deviendra jamais true tout seul).
export default function OnboardingScreen({ status, onSkip }) {
  const logs = status?.logs ?? [];
  // Ne pas confondre avec l'état dégradé _error (hubUrl toujours null par
  // construction sur un échec réseau) : un Hub configuré mais momentanément
  // injoignable ne doit pas afficher un raccourci trompeur vers TECH_PASSWORD.
  const autonome = !status?.hubUrl && !status?._error;

  return (
    <div className="screen screen--center" style={{ maxWidth: '520px', margin: '0 auto', textAlign: 'left' }}>
      <h2 className="screen__title">Borne pas encore appairée</h2>
      <p className="text--muted">
        Aucun token n'est configuré sur cette machine. Renseignez <code>BORNE_TOKEN</code> dans
        le <code>.env</code> (copié depuis le token affiché par le Hub, onglet Bornes) puis
        redémarrez le conteneur.
      </p>
      {status?._error && (
        <p className="text--error" role="alert">
          Impossible de contacter la borne pour l'instant — nouvelle tentative automatique en cours.
        </p>
      )}

      <section className="panel-section" style={{ marginTop: '16px' }}>
        <h3 className="panel-section__title">État</h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '14px' }}>
          <li>Hub configuré : {status?.hubUrl ? <code>{status.hubUrl}</code> : <em>non</em>}</li>
          <li>Token : <em>absent</em></li>
        </ul>
      </section>

      <section className="panel-section" style={{ marginTop: '16px' }}>
        <h3 className="panel-section__title">Journal</h3>
        {logs.length === 0 ? (
          <p className="text--muted" style={{ fontSize: '13px' }}>Aucun événement pour l'instant.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'monospace', fontSize: '12px', maxHeight: '260px', overflowY: 'auto' }}>
            {logs.slice().reverse().map((entry, i) => (
              <li key={i} style={{ color: LEVEL_COLOR[entry.level] ?? 'inherit', marginBottom: '4px' }}>
                [{new Date(entry.at).toLocaleTimeString()}] {entry.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {autonome && onSkip && (
        <button type="button" className="btn btn--ghost" style={{ marginTop: '16px' }} onClick={onSkip}>
          Pas de Hub prévu — se connecter avec TECH_PASSWORD →
        </button>
      )}
    </div>
  );
}

// Interroge périodiquement /api/sync/pairing-status. Retourne null pendant le
// tout premier chargement, puis toujours le dernier statut connu — même en cas
// d'échec réseau/429 : un statut dégradé { _error: true } évite un écran blanc
// permanent (BornePage doit toujours avoir quelque chose à rendre après le
// premier tick), le polling continue en tâche de fond pour se rétablir seul.
export function usePairingStatus(active) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let succeededOnce = false;
    const poll = () => api.pairingStatus()
      .then((s) => { if (!cancelled) { succeededOnce = true; setStatus(s); } })
      .catch(() => {
        if (!cancelled && !succeededOnce) {
          setStatus({ hasToken: false, hasActiveEvent: false, hubUrl: null, lastPull: null, logs: [], _error: true });
        }
      });
    poll();
    const timer = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  return status;
}
