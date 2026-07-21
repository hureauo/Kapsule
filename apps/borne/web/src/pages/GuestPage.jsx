import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getGeneralToken, saveGeneralToken, setVideoSettingsPublic } from '../api/client.js';
import { DEFAULTS } from '@kapsule/core';
import {
  StartScreen, QuestionNav, QuestionSheet, ThankYouScreen, NameInput, RecapScreen, RecordingScreen,
} from '@kapsule/guest-ui';
import { applyDesign } from '../utils/design.js';
import { uploadVideo, guestVideoUrl } from '../api/client.js';

// ── sessionStorage : reprise après crash/reload (spec §8) ────────────────────
const SESSION_KEY = 'kapsule_session';

function saveSession(sessionId, guestName, questionIndex) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, guestName, questionIndex }));
  } catch { /* stockage indisponible — non bloquant */ }
}

function loadSavedSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearSavedSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ }
}

// ── Écrans utilitaires ────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="screen screen--center">
      <p className="text--muted">Chargement…</p>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div className="screen screen--center">
      <p className="text--error">{message}</p>
      {onRetry && (
        <button className="btn btn--primary" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

function ClosedScreen() {
  return (
    <div className="screen screen--center">
      <h2 className="screen__title">L'événement est terminé</h2>
      <p className="text--muted">Merci de votre participation.</p>
    </div>
  );
}

// Écran de reprise : proposé quand une session non complétée est trouvée
// en sessionStorage au rechargement (spec §8).
function ResumeScreen({ guestName, onResume, onRestart }) {
  return (
    <div className="screen screen--center">
      <h2 className="screen__title">Reprendre la session de {guestName} ?</h2>
      <p className="text--muted">Vous aviez commencé à répondre. Voulez-vous continuer ?</p>
      <div className="resume__actions">
        <button className="btn btn--secondary btn--large" onClick={onRestart}>
          Recommencer
        </button>
        <button className="btn btn--primary btn--large" onClick={onResume}>
          Reprendre ▶
        </button>
      </div>
    </div>
  );
}

// ── Écran de login preview (role general) ────────────────────────────────────
function PreviewLoginScreen({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.login(email, password);
      saveGeneralToken(data.token);
      onSuccess();
    } catch {
      setError('Identifiants incorrects.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login screen screen--center">
      <h2 className="screen__title">Accès invité</h2>
      <form onSubmit={handleSubmit} className="name-form">
        <input
          className="name-form__input"
          type="email"
          autoFocus
          value={email}
          onChange={e => { setEmail(e.target.value); setError(''); }}
          placeholder="Email"
          disabled={loading}
        />
        <input
          className="name-form__input"
          type="password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(''); }}
          placeholder="Mot de passe"
          disabled={loading}
        />
        {error && <p className="text--error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--large" type="submit" disabled={loading}>
          {loading ? 'Connexion…' : 'Accéder'}
        </button>
      </form>
    </div>
  );
}

// ── Machine à états principale ────────────────────────────────────────────────
// États : loading | error | closed | login | resume | start | name | questions | recap | thanks

const S = {
  LOADING: 'loading', ERROR: 'error', CLOSED: 'closed',
  LOGIN: 'login',
  RESUME: 'resume',
  START: 'start', NAME: 'name', QUESTIONS: 'questions',
  RECAP: 'recap', THANKS: 'thanks',
};

// V2.8 — inactivité recentrée sur NAME uniquement : seul écran où un invité peut
// « bloquer » la borne (clavier affiché, personne devant). Sur NAME il n'y a rien
// à perdre → retour direct accueil sans modale intermédiaire (design/parcours-invite.md §9).
// QUESTIONS exclu : rec/upload y vivent et ne doivent jamais être interrompus.
const IDLE_SCREENS = new Set([S.NAME]);

// Correspondance état runtime → écran design (design3, DESIGN_SCREENS de
// @kapsule/core). Un état absent de cette table (LOADING/ERROR/CLOSED/LOGIN/
// RESUME/RECAP) retombe sur `undefined` → resolveScreenColors applique les
// couleurs globales (dégradation silencieuse assumée, pas de crash).
const DESIGN_SCREEN_BY_STATE = {
  [S.START]: 'start',
  [S.NAME]: 'name',
  [S.QUESTIONS]: 'recording',
  [S.THANKS]: 'thanks',
};

export default function GuestPage({ isPreview = false }) {
  const [screen, setScreen] = useState(S.LOADING);
  const [event, setEvent] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [navLocked, setNavLocked] = useState(false); // verrou nav basse pendant rec/upload

  const [sessionId, setSessionId] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  // Origine d'entrée dans une question :
  //   'flow'  — parcours linéaire (question suivante)
  //   'recap' — ré-enregistrement depuis le récap (retour au récap après upload)
  //   'sheet' — navigation depuis le panneau slide-up (retour à returnIndex après upload)
  const [questionOrigin, setQuestionOrigin] = useState('flow');
  const [returnIndex, setReturnIndex] = useState(0); // question à retrouver après origin='sheet'
  const [sheetOpen, setSheetOpen] = useState(false);
  const [answers, setAnswers] = useState([]);

  // V2.7 — confirmation avant retour accueil
  const [homeConfirmVisible, setHomeConfirmVisible] = useState(false);

  const idleTimerRef = useRef(null);
  // Ref stable vers handleRestart pour le callback idle, afin d'éviter une
  // dépendance circulaire dans resetIdleTimer (qui est un useCallback stable).
  const handleRestartRef = useRef(null);

  const loadEvent = useCallback(async (silent = false) => {
    if (!silent) setScreen(S.LOADING);
    try {
      const [evtData, qData] = await Promise.all([api.getEvent(), api.getQuestions()]);
      setEvent(evtData);
      setQuestions(qData.filter((q) => q.enabled));

      // Applique le thème choisi par l'admin (data-theme sur <html>) — défaut 'cute'.
      document.documentElement.setAttribute('data-theme', evtData.theme ?? 'cute');

      // Le design personnalisé de l'événement (s'il existe) est appliqué par le
      // useEffect [screen, event] ci-dessous — il pose des custom properties
      // par-dessus le thème (§9bis) et se réévalue à chaque écran (design3).

      if (evtData.status === 'closed') {
        setScreen(S.CLOSED);
        return;
      }

      // Preview protégée : vérifier si un token general est déjà présent
      if (evtData.requiresLogin && !getGeneralToken()) {
        setScreen(S.LOGIN);
        return;
      }

      // Reprise après reload : si une session est sauvegardée, proposer de reprendre
      const saved = loadSavedSession();
      if (saved?.sessionId) {
        setSessionId(saved.sessionId);
        setGuestName(saved.guestName ?? '');
        setQuestionIndex(saved.questionIndex ?? 0);
        setAnswers([]);
        setScreen(S.RESUME);
      } else {
        setScreen(S.START);
      }
    } catch (e) {
      setErrorMsg(e.message);
      setScreen(S.ERROR);
    }
  }, []);

  useEffect(() => { loadEvent(); }, [loadEvent]);

  // Réapplique le design à chaque changement d'écran (design3) : une surcharge
  // par écran ne peut prendre effet que si applyDesign est rappelée avec l'écran
  // courant — l'appel unique au chargement (dans loadEvent) ne suffit plus.
  // Idempotent avec l'appel initial (mêmes valeurs si aucune surcharge).
  useEffect(() => {
    if (!event) return;
    applyDesign(event.design ?? null, DESIGN_SCREEN_BY_STATE[screen]);
  }, [screen, event]);

  // ── Polling config en mode preview ────────────────────────────────────────
  // Sur la borne réelle, la config ne change pas en cours d'événement.
  // En preview, l'admin peut modifier design/questions depuis le Hub à tout moment :
  // le Hub pousse un pull à la borne (BD mise à jour), et ce poll rafraîchit le SPA.
  //
  // Actif uniquement sur START et LOGIN (écrans "salle d'attente" sans session invité
  // en cours). Désactivé pendant NAME/QUESTIONS/RECAP/THANKS pour ne jamais
  // interrompre un enregistrement ou un upload.
  const POLLABLE_SCREENS = new Set([S.START, S.LOGIN]);
  useEffect(() => {
    if (!isPreview || !POLLABLE_SCREENS.has(screen)) return;
    const id = setInterval(() => loadEvent(true), 3000);
    return () => clearInterval(id);
  }, [isPreview, screen, loadEvent]);

  // Récupère les réponses connues pour les pastilles QuestionNav
  const refreshAnswers = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getAnswers(sessionId);
      setAnswers(data ?? []);
    } catch { /* non bloquant */ }
  }, [sessionId]);

  // ── Timeout d'inactivité v2 (NAME uniquement → retour direct accueil) ─────────
  const idleMs = (event?.idle_timeout ?? DEFAULTS.IDLE_TIMEOUT_S) * 1000;

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Appelle handleRestart via ref : ne dépend pas de handleRestart (récréé chaque render)
    idleTimerRef.current = setTimeout(() => handleRestartRef.current?.(), idleMs);
  }, [idleMs]);

  useEffect(() => {
    if (!IDLE_SCREENS.has(screen)) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      return;
    }
    resetIdleTimer();
    window.addEventListener('touchstart', resetIdleTimer);
    window.addEventListener('mousemove', resetIdleTimer);
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      window.removeEventListener('touchstart', resetIdleTimer);
      window.removeEventListener('mousemove', resetIdleTimer);
    };
  }, [screen, resetIdleTimer]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleStart() { setScreen(S.NAME); }

  function handleSession(sid, name) {
    setSessionId(sid);
    setGuestName(name);
    setQuestionIndex(0);
    setQuestionOrigin('flow');
    setAnswers([]);
    saveSession(sid, name, 0);
    setScreen(S.QUESTIONS);
  }

  // Après l'upload d'une réponse :
  // - origine 'recap' → retour au récap
  // - origine 'sheet' → retour à la question d'où le panneau avait été ouvert (returnIndex)
  // - origine 'flow'  → question suivante, ou récap si dernière question
  function handleQuestionNext() {
    refreshAnswers();
    if (questionOrigin === 'recap') {
      setQuestionOrigin('flow');
      setScreen(S.RECAP);
    } else if (questionOrigin === 'sheet') {
      setQuestionOrigin('flow');
      saveSession(sessionId, guestName, returnIndex);
      setQuestionIndex(returnIndex);
    } else if (questionIndex < questions.length - 1) {
      const next = questionIndex + 1;
      saveSession(sessionId, guestName, next);
      setQuestionIndex(next);
    } else {
      refreshAnswers();
      setScreen(S.RECAP);
    }
  }

  // Navigation depuis le panneau slide-up → après upload, revenir à la question courante.
  // Seules les questions déjà répondues sont accessibles (les futures restent bloquées).
  function handleSheetGo(i) {
    setSheetOpen(false);
    if (i === questionIndex) return; // déjà sur cette question, juste fermer
    const targetAnswered = answers.some((a) => (a.question_id ?? a) === questions[i]?.id);
    if (!targetAnswered) return; // garde : question future — ne pas naviguer
    setReturnIndex(questionIndex);
    setQuestionOrigin('sheet');
    refreshAnswers();
    saveSession(sessionId, guestName, i);
    setQuestionIndex(i);
  }

  // Navigation depuis le récap → après upload, revenir au récap
  function handleRecapGo(i) {
    saveSession(sessionId, guestName, i);
    setQuestionIndex(i);
    setQuestionOrigin('recap');
    setScreen(S.QUESTIONS);
  }

  function handleRecapFinish() {
    clearSavedSession(); // session complétée → nettoyage (spec §8)
    setScreen(S.THANKS);
  }

  function handleRestart() {
    clearSavedSession(); // reset complet (inactivité ou bouton Accueil)
    setSessionId(null);
    setGuestName('');
    setQuestionIndex(0);
    setReturnIndex(0);
    setQuestionOrigin('flow');
    setSheetOpen(false);
    setAnswers([]);
    setHomeConfirmVisible(false);
    loadEvent();
  }

  // Exposer handleRestart via ref pour le callback idle (resetIdleTimer ne peut
  // pas dépendre directement de handleRestart sans le recréer à chaque render)
  handleRestartRef.current = handleRestart;

  // Reprise : l'utilisateur accepte de reprendre sa session sauvegardée
  function handleResume() {
    refreshAnswers();
    setScreen(S.QUESTIONS);
  }

  // Bouton Accueil visible sur tous les écrans du parcours sauf pendant le
  // verrou nav (COUNTDOWN/RECORDING/UPLOADING) et les écrans système (V2.7).
  const showHomeButton =
    !navLocked &&
    screen !== S.LOADING &&
    screen !== S.ERROR &&
    screen !== S.CLOSED;

  // ── Rendu ─────────────────────────────────────────────────────────────────────

  if (screen === S.LOADING) return <LoadingScreen />;
  if (screen === S.ERROR)   return <ErrorScreen message={errorMsg} onRetry={loadEvent} />;
  if (screen === S.CLOSED)  return <ClosedScreen />;
  if (screen === S.LOGIN)   return <PreviewLoginScreen onSuccess={loadEvent} />;

  return (
    <>
      {isPreview && (
        <div className="guest-preview-banner" role="status">
          BORNE D'ESSAI
        </div>
      )}
      {/* Bouton Accueil 🏠 — coin haut gauche, sauf pendant le REC/upload (V2.7) */}
      {showHomeButton && (
        <button
          className="guest-home-btn"
          aria-label="Retourner à l'accueil"
          onClick={() => setHomeConfirmVisible(true)}
        >
          🏠
        </button>
      )}

      {/* Modal de confirmation retour accueil — action destructive (V2.7) */}
      {homeConfirmVisible && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3 className="modal__title">Revenir à l'accueil ?</h3>
            <p className="text--muted">Tes réponses seront perdues.</p>
            <div className="modal__actions">
              <button
                className="btn btn--small btn--secondary"
                onClick={() => setHomeConfirmVisible(false)}
              >
                Annuler
              </button>
              <button className="btn btn--small btn--danger" onClick={handleRestart}>
                Tout effacer
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === S.RESUME && (
        <ResumeScreen
          guestName={guestName}
          onResume={handleResume}
          onRestart={handleRestart}
        />
      )}

      {screen === S.START && (
        <StartScreen
          event={event}
          onStart={handleStart}
          onVideoSettingsChange={isPreview ? async (patch) => {
            await setVideoSettingsPublic(patch).catch(() => {});
            loadEvent(); // recharge event pour que qualité/orientation soient à jour avant le REC
          } : undefined}
        />
      )}

      {screen === S.NAME && (
        <NameInput
          event={event}
          onSession={handleSession}
          onBack={() => setScreen(S.START)}
          onClosed={() => setScreen(S.CLOSED)}
          createSession={api.createSession}
        />
      )}

      {screen === S.QUESTIONS && questions.length > 0 && (() => {
        const q = questions[questionIndex];
        const existingAnswer = answers.find((a) => (a.question_id ?? a) === q.id);
        return (
          <div className="questions-layout">
            {/* key force le remount complet à chaque changement de question */}
            <RecordingScreen
              key={`${sessionId}-q${questionIndex}`}
              question={q}
              sessionId={sessionId}
              existingVideoId={existingAnswer?.video_id ?? null}
              onNext={handleQuestionNext}
              onLockChange={setNavLocked}
              qualityKey={event?.video_quality}
              orientation={event?.video_orientation}
              uploadVideo={uploadVideo}
              guestVideoUrl={guestVideoUrl}
            />
            {/* Barre de progression en BAS — tap ou swipe up → ouvre le panneau */}
            <QuestionNav
              questions={questions}
              currentIndex={questionIndex}
              answers={answers}
              onOpenSheet={() => setSheetOpen(true)}
              locked={navLocked}
            />
            {/* Panneau slide-up de navigation inter-questions */}
            {sheetOpen && (
              <QuestionSheet
                questions={questions}
                currentIndex={questionIndex}
                answers={answers}
                onGo={handleSheetGo}
                onClose={() => setSheetOpen(false)}
              />
            )}
          </div>
        );
      })()}

      {screen === S.QUESTIONS && questions.length === 0 && (
        <div className="screen screen--center">
          <p className="text--muted">Aucune question configurée pour cet événement.</p>
          <button className="btn btn--primary" onClick={() => setScreen(S.RECAP)}>Terminer</button>
        </div>
      )}

      {screen === S.RECAP && (
        <RecapScreen
          questions={questions}
          answers={answers}
          sessionId={sessionId}
          onGo={handleRecapGo}
          onFinish={handleRecapFinish}
          onFinishSession={api.completeSession}
        />
      )}

      {/* V2.3 : thanksText branché sur event.thanks_text */}
      {screen === S.THANKS && (
        <ThankYouScreen
          onRestart={handleRestart}
          thanksText={event?.thanks_text}
          design={event?.design ?? null}
        />
      )}
    </>
  );
}
