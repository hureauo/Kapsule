import React, { useEffect, useRef, useState } from 'react';
import { api, saveTechToken } from '../../api/client.js';

// Écran affiché sur /borne tant que l'appairage n'est pas confirmé par le
// technicien (Phase C) — avant appairage, rien de sensible n'existe encore
// ici, donc pas de mot de passe requis : la console montre la progression pas
// à pas (4 étapes, cf. computeSteps ci-dessous) et permet de coller le token
// borne directement ici (POST /api/sync/onboarding/pair) au lieu d'éditer le
// .env + redémarrer le conteneur. Un pull réussi (preuve que le Hub a validé
// CE token) ouvre directement une session technicien (le serveur émet un JWT,
// sauvegardé ici via saveTechToken) — plus de TECH_PASSWORD à connaître en
// plus du token (retiré, PROJET.md §11.30). Reste montée après un appairage
// réussi — le temps d'afficher le résultat concret du pull (événement
// chargé ? aucun assigné ? pull échoué, à corriger et réessayer ?) — jusqu'à
// ce que le technicien clique « Continuer » (onDone). Le parent (BornePage
// ou App, racine) décide alors de basculer vers l'écran suivant.
// var(--color-muted) n'a jamais existé dans app.css (le token s'appelle
// --text-muted) — sans fallback, ces couleurs invalides retombaient sur la
// couleur héritée, incohérente selon le data-theme laissé sur <html> par le
// dernier parcours invité affiché sur cette même page (illisible constaté).
const LEVEL_COLOR = { info: 'var(--text-muted)', error: 'var(--text-error, #dc2626)' };

const STEP_ICON = { done: '✓', current: '…', error: '✗', pending: '○' };
const STEP_COLOR = {
  done: 'var(--success, #2d8a4e)',
  current: 'var(--text-muted)',
  error: 'var(--error, #c0392b)',
  pending: 'var(--text-muted)',
};

// Calcule les 4 étapes du premier démarrage à partir de ce qu'on sait CE
// TOUR-CI : l'état du sondage pairing-status (serveur joignable ? Hub
// préconfiguré ?), l'état local du formulaire (soumission en cours ?), et le
// résultat de POST .../onboarding/pair une fois reçu (pairResult) — qui seul
// confirme si le pull a réellement réussi, plutôt que de deviner depuis un
// hasToken devenu true qui ne dit rien du sort du pull.
function computeSteps({ status, pairResult, pairing, pairError, hubUrlInput }) {
  const serverStep = status?._error
    ? { state: 'error', detail: 'Injoignable — nouvel essai automatique en cours…' }
    : { state: 'done', detail: 'Backend de la borne accessible' };

  const hubConfigured = status?.hubUrl || pairResult;
  const hubStep = hubConfigured
    ? { state: 'done', detail: status?.hubUrl ? status.hubUrl : 'Renseigné à l\'appairage' }
    : { state: 'pending', detail: hubUrlInput?.trim() ? 'Saisi, pas encore envoyé' : 'À saisir ci-dessous' };

  let tokenStep;
  if (pairResult && pairResult.pull.ok) {
    tokenStep = { state: 'done', detail: `Token ${pairResult.tokenKind === 'borne' ? 'de borne' : 'd\'événement'} validé par le Hub` };
  } else if (pairResult && !pairResult.pull.ok) {
    tokenStep = { state: 'error', detail: 'Rejeté ou pull impossible avec ce token — corrigez et réessayez ci-dessous' };
  } else if (pairError) {
    tokenStep = { state: 'error', detail: pairError };
  } else if (pairing) {
    tokenStep = { state: 'current', detail: 'Envoi au Hub en cours…' };
  } else {
    tokenStep = { state: 'pending', detail: 'À coller ci-dessous' };
  }

  let eventStep;
  if (!pairResult) {
    eventStep = { state: 'pending', detail: 'En attente du token' };
  } else if (!pairResult.pull.ok) {
    eventStep = { state: 'error', detail: `Pull échoué — ${pairResult.pull.error}. Nouvel essai au prochain battement.` };
  } else if (pairResult.hasActiveEvent) {
    eventStep = { state: 'done', detail: 'Événement récupéré et chargé' };
  } else {
    eventStep = { state: 'current', detail: 'Aucun événement assigné pour l\'instant — assignez-en un depuis le Hub, onglet Bornes' };
  }

  return [
    { label: 'Serveur borne', ...serverStep },
    { label: 'Hub', ...hubStep },
    { label: 'Token', ...tokenStep },
    { label: 'Événement', ...eventStep },
  ];
}

function StepList({ steps }) {
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((step) => (
        <li key={step.label} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
          <span
            aria-hidden="true"
            style={{
              color: STEP_COLOR[step.state],
              fontWeight: 'bold',
              width: '18px',
              flexShrink: 0,
              textAlign: 'center',
            }}
          >
            {STEP_ICON[step.state]}
          </span>
          <span>
            <strong style={{ fontSize: '14px' }}>{step.label}</strong>
            <br />
            <span className="text--muted" style={{ fontSize: '13px' }}>{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// onDone : le technicien a vu le résultat de l'appairage et veut continuer
// vers le login — c'est ce qui fait basculer BornePage, pas hasToken seul
// (sinon l'écran disparaîtrait avant même d'afficher le résultat du pull).
export default function OnboardingScreen({ status, onDone }) {
  const logs = status?.logs ?? [];

  const [token, setToken] = useState('');
  const [hubUrl, setHubUrl] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState('');
  const [pairResult, setPairResult] = useState(null);

  async function handlePair(e) {
    e.preventDefault();
    if (!token.trim()) return;
    setPairing(true);
    setPairError('');
    try {
      const result = await api.onboardingPair(token.trim(), hubUrl.trim());
      // Le token borne vient d'être validé par le Hub (pull.ok) — c'est la
      // preuve d'autorisation elle-même, pas besoin d'un mot de passe séparé
      // pour ouvrir la session technicien : le serveur en a déjà émis une.
      if (result.token) saveTechToken(result.token);
      setPairResult(result);
    } catch (err) {
      setPairError(err.message);
    } finally {
      setPairing(false);
    }
  }

  const steps = computeSteps({ status, pairResult, pairing, pairError, hubUrlInput: hubUrl });

  return (
    <div
      className="admin-login screen screen--center"
      style={{
        maxWidth: '520px',
        margin: '0 auto',
        textAlign: 'left',
        // .screen--center centre le contenu verticalement dans une hauteur
        // fixe (100%) — correct pour un login court, mais ce tracker à 4
        // étapes + formulaire/confirmation + journal dépasse souvent la
        // hauteur de l'écran. Sans ça le haut du contenu se retrouve centré
        // hors-viewport (illisible) puisque html/body/#root bloquent tout
        // scroll de page (kiosque). On ne touche pas .screen--center partagée
        // avec le kiosque invité (AdminLogin y reste, contenu court) — juste
        // cette instance, via un scroll interne.
        justifyContent: 'flex-start',
        overflowY: 'auto',
      }}
    >
      <h2 className="screen__title">Borne pas encore appairée</h2>
      <p className="text--muted">
        Aucun token n'est configuré sur cette machine. Collez ci-dessous le token affiché par le
        Hub (onglet Bornes → « + Nouvelle borne ») — ou, si vous préférez, renseignez
        <code> BORNE_TOKEN</code> dans le <code>.env</code> et redémarrez le conteneur.
      </p>

      <section className="panel-section" style={{ marginTop: '16px' }}>
        <h3 className="panel-section__title">Progression</h3>
        <StepList steps={steps} />
      </section>

      {(!pairResult || !pairResult.pull.ok) && (
        <section className="panel-section" style={{ marginTop: '16px' }}>
          <h3 className="panel-section__title">Appairage</h3>
          {pairResult && !pairResult.pull.ok && (
            <p className="text--error" style={{ fontSize: '13px', marginBottom: '8px' }}>
              Le pull a échoué avec ce token — {pairResult.pull.error}. Vérifiez le token (et
              l'URL du Hub) puis réessayez ; rien n'est verrouillé tant qu'aucun pull n'a abouti.
            </p>
          )}
          <form onSubmit={handlePair}>
            <div style={{ marginBottom: '8px' }}>
              <label htmlFor="onboarding-token" style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                Token de borne
              </label>
              <input
                id="onboarding-token"
                className="admin-input"
                type="text"
                placeholder="Collé depuis le Hub…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </div>
            {!status?.hubUrl && (
              <div style={{ marginBottom: '8px' }}>
                <label htmlFor="onboarding-hub-url" style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                  URL du Hub
                </label>
                <input
                  id="onboarding-hub-url"
                  className="admin-input"
                  type="text"
                  placeholder="https://votre-domaine.com"
                  value={hubUrl}
                  onChange={(e) => setHubUrl(e.target.value)}
                />
              </div>
            )}
            <button type="submit" className="btn btn--primary btn--small" disabled={pairing || !token.trim()}>
              {pairing ? '…' : (pairResult ? 'Réessayer' : 'Appairer')}
            </button>
          </form>
        </section>
      )}

      {pairResult && pairResult.pull.ok && (
        <section className="panel-section" style={{ marginTop: '16px' }}>
          <h3 className="panel-section__title">Appairage terminé</h3>
          <p className="text--muted" style={{ fontSize: '13px' }}>
            {pairResult.hasActiveEvent
              ? 'Token et événement chargés — la borne est prête, vous êtes déjà connecté.'
              : 'Token validé. Assignez un événement à cette borne depuis le Hub (onglet Bornes) — vous êtes déjà connecté, inutile de vous reconnecter.'}
          </p>
          <button type="button" className="btn btn--primary btn--small" onClick={onDone}>
            Continuer →
          </button>
        </section>
      )}

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
    </div>
  );
}

// Interroge périodiquement /api/sync/pairing-status. Retourne null pendant le
// tout premier chargement, puis toujours le dernier statut connu — même en cas
// d'échec réseau/429 : un statut dégradé { _error: true } évite un écran blanc
// permanent (BornePage doit toujours avoir quelque chose à rendre après le
// premier tick), le polling continue en tâche de fond pour se rétablir seul —
// SAUF une fois `stopWhen(status)` vrai, où plus rien ne reste à apprendre en
// sondant. Le défaut (`hasToken`) convient à useOnboardingGate ci-dessous :
// l'identité de la borne ne change plus sans redéploiement/reset (qui recharge
// la page de toute façon). Mais un appelant qui attend un signal PLUS TARDIF —
// GuestPage/NotConfiguredScreen attend `hasActiveEvent`, qui peut rester faux
// longtemps après hasToken=true (borne appairée sans événement assigné) —
// doit pouvoir le dire explicitement, sinon il ne se répare jamais tout seul.
// Ce hook est monté à la RACINE (App.jsx, pas seulement /borne) : sur une
// preview Internet-facing, chaque onglet visiteur le montait indéfiniment et
// consommait sa part du rate-limit partagé (60/min/IP) pour une information
// figée — d'où l'arrêt par défaut, pas son absence.
const DEFAULT_STOP_WHEN = (s) => s.hasToken;

export function usePairingStatus(active, stopWhen = DEFAULT_STOP_WHEN) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let succeededOnce = false;
    let timer = null;
    const poll = () => api.pairingStatus()
      .then((s) => {
        if (cancelled) return;
        succeededOnce = true;
        setStatus(s);
        if (stopWhen(s) && timer) {
          clearInterval(timer);
          timer = null;
        }
      })
      .catch(() => {
        if (!cancelled && !succeededOnce) {
          setStatus({ hasToken: false, hasActiveEvent: false, hubUrl: null, lastPull: null, logs: [], _error: true });
        }
      });
    poll();
    timer = setInterval(poll, 4000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopWhen : un
    // prédicat stable par appelant (constante module ou closure figée), pas un
    // state réactif ; le re-déclarer en dépendance relancerait le polling à
    // chaque rendu pour des appelants passant une fonction inline.
  }, [active]);

  return status;
}

// Combine usePairingStatus() avec la logique "reste sur l'onboarding jusqu'à
// confirmation explicite" — partagée entre BornePage (/borne) et App (racine,
// cf. App.jsx) plutôt que dupliquée deux fois. Se souvient (sawUnpairedRef,
// un ref — mutation visible dans le même rendu, pas au suivant comme un
// effect, pour ne jamais flasher l'écran suivant avant l'onboarding sur une
// borne vraiment neuve) d'avoir vu la borne non appairée PENDANT cette
// session ; dans ce cas reste dessus même après que hasToken passe à true,
// jusqu'au clic sur « Continuer » (confirmOnboarding). /borne et la racine
// (App.jsx) partagent exactement le même comportement — il n'existe plus de
// "mode autonome" à traiter différemment (§1 PROJET.md : capacité retirée du
// code depuis Phase 6E, jamais restaurée — POST /api/events, qui créait un
// événement local sans Hub, a été supprimé le 18/06 sans être remplacé).
// hasToken=false sans HUB_URL n'est donc plus un état permanent légitime :
// c'est juste "pas encore configurée", au même titre qu'avec un HUB_URL
// préconfiguré — le formulaire d'appairage propose de toute façon un champ
// URL du Hub quand elle manque.
export function useOnboardingGate(active) {
  const pairing = usePairingStatus(active);
  const sawUnpairedRef = useRef(false);
  const [confirmed, setConfirmed] = useState(false);

  // !pairing._error : un statut dégradé (poll raté — 429, réseau) porte
  // toujours hasToken:false (valeur par défaut du fallback, cf. usePairingStatus
  // ci-dessus) sans rien dire du VRAI hasToken. Sans cette garde, un seul poll
  // raté fige durablement l'onboarding en avant du kiosque (et, sur une
  // preview, de la page publique) même sur une borne déjà appairée — jusqu'à
  // un clic humain sur « Continuer » qui n'a plus lieu d'être proposé.
  if (pairing && pairing.hasToken === false && !pairing._error) sawUnpairedRef.current = true;

  const showOnboarding = active && Boolean(pairing) && sawUnpairedRef.current && (!pairing.hasToken || !confirmed);

  return { pairing, showOnboarding, confirmOnboarding: () => setConfirmed(true) };
}
