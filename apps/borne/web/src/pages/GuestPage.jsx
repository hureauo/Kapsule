import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { DEFAULTS } from '@kapsule/core';
import StartScreen from '../components/guest/StartScreen.jsx';
import NameInput from '../components/guest/NameInput.jsx';
import QuestionNav from '../components/guest/QuestionNav.jsx';
import RecordingScreen from '../components/guest/RecordingScreen.jsx';
import RecapScreen from '../components/guest/RecapScreen.jsx';
import ThankYouScreen from '../components/guest/ThankYouScreen.jsx';

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

// Modale d'inactivité : compte à rebours 30 s puis retour accueil (spec §8).
// La session abandonnée reste en base.
const IDLE_MODAL_S = 30;

function IdleModal({ onStay, onLeave }) {
  const [remaining, setRemaining] = useState(IDLE_MODAL_S);

  useEffect(() => {
    if (remaining <= 0) { onLeave(); return; }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, onLeave]);

  return (
    <div className="idle-modal-overlay">
      <div className="idle-modal">
        <h2 className="idle-modal__title">Tu es toujours là ?</h2>
        <p className="text--muted idle-modal__countdown">
          Retour à l'accueil dans {remaining} s…
        </p>
        <button className="btn btn--primary btn--large" onClick={onStay}>
          Oui, je continue
        </button>
      </div>
    </div>
  );
}

// ── Machine à états principale ────────────────────────────────────────────────
// États : loading | error | closed | resume | start | name | questions | recap | thanks

const S = {
  LOADING: 'loading', ERROR: 'error', CLOSED: 'closed',
  RESUME: 'resume',
  START: 'start', NAME: 'name', QUESTIONS: 'questions',
  RECAP: 'recap', THANKS: 'thanks',
};

// Écrans sur lesquels le timeout d'inactivité est actif.
// QUESTIONS est exclu : rec/upload y vivent et ne doivent jamais être interrompus.
const IDLE_SCREENS = new Set([S.RESUME, S.START, S.NAME, S.RECAP, S.THANKS]);

export default function GuestPage() {
  const [screen, setScreen] = useState(S.LOADING);
  const [event, setEvent] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [idleModalVisible, setIdleModalVisible] = useState(false);

  const [sessionId, setSessionId] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState([]);

  const idleTimerRef = useRef(null);

  const loadEvent = useCallback(async () => {
    setIdleModalVisible(false);
    setScreen(S.LOADING);
    try {
      const [evtData, qData] = await Promise.all([api.getEvent(), api.getQuestions()]);
      setEvent(evtData);
      setQuestions(qData.filter((q) => q.enabled));

      if (evtData.status === 'closed') {
        setScreen(S.CLOSED);
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

  // Récupère les réponses connues pour les pastilles QuestionNav
  const refreshAnswers = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getAnswers(sessionId);
      setAnswers(data ?? []);
    } catch { /* non bloquant */ }
  }, [sessionId]);

  // ── Timeout d'inactivité (spec §8) ───────────────────────────────────────────
  const idleMs = (event?.idle_timeout ?? DEFAULTS.IDLE_TIMEOUT_S) * 1000;

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdleModalVisible(true), idleMs);
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
    setAnswers([]);
    saveSession(sid, name, 0);
    setScreen(S.QUESTIONS);
  }

  function handleQuestionNext() {
    refreshAnswers();
    if (questionIndex < questions.length - 1) {
      const next = questionIndex + 1;
      saveSession(sessionId, guestName, next);
      setQuestionIndex(next);
    } else {
      refreshAnswers();
      setScreen(S.RECAP);
    }
  }

  function handleQuestionBack() {
    refreshAnswers();
    if (questionIndex > 0) {
      const prev = questionIndex - 1;
      saveSession(sessionId, guestName, prev);
      setQuestionIndex(prev);
    } else {
      setScreen(S.NAME);
    }
  }

  function handleGoQuestion(i) {
    if (i >= 0 && i < questions.length) {
      refreshAnswers();
      saveSession(sessionId, guestName, i);
      setQuestionIndex(i);
    }
  }

  function handleRecapGo(i) {
    saveSession(sessionId, guestName, i);
    setQuestionIndex(i);
    setScreen(S.QUESTIONS);
  }

  function handleRecapFinish() {
    clearSavedSession(); // session complétée → nettoyage (spec §8)
    setScreen(S.THANKS);
  }

  function handleRestart() {
    clearSavedSession(); // timeout d'inactivité → nettoyage (spec §8)
    setSessionId(null);
    setGuestName('');
    setQuestionIndex(0);
    setAnswers([]);
    loadEvent();
  }

  // Reprise : l'utilisateur accepte de reprendre sa session sauvegardée
  function handleResume() {
    refreshAnswers();
    setScreen(S.QUESTIONS);
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────────

  if (screen === S.LOADING) return <LoadingScreen />;
  if (screen === S.ERROR)   return <ErrorScreen message={errorMsg} onRetry={loadEvent} />;
  if (screen === S.CLOSED)  return <ClosedScreen />;

  return (
    <>
      {/* Modale d'inactivité — superposée à tout écran IDLE_SCREENS */}
      {idleModalVisible && (
        <IdleModal
          onStay={() => { setIdleModalVisible(false); resetIdleTimer(); }}
          onLeave={handleRestart}
        />
      )}

      {screen === S.RESUME && (
        <ResumeScreen
          guestName={guestName}
          onResume={handleResume}
          onRestart={handleRestart}
        />
      )}

      {screen === S.START && <StartScreen event={event} onStart={handleStart} />}

      {screen === S.NAME && (
        <NameInput
          event={event}
          onSession={handleSession}
          onBack={() => setScreen(S.START)}
        />
      )}

      {screen === S.QUESTIONS && questions.length > 0 && (() => {
        const q = questions[questionIndex];
        const existingAnswer = answers.find((a) => (a.question_id ?? a) === q.id);
        return (
          <div className="questions-layout">
            <QuestionNav
              questions={questions}
              currentIndex={questionIndex}
              answers={answers}
              onGo={handleGoQuestion}
            />
            {/* key force le remount complet à chaque changement de question */}
            <RecordingScreen
              key={`${sessionId}-q${questionIndex}`}
              question={q}
              questionIndex={questionIndex}
              totalQuestions={questions.length}
              sessionId={sessionId}
              existingVideoId={existingAnswer?.video_id ?? null}
              onNext={handleQuestionNext}
              onBack={handleQuestionBack}
            />
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
        />
      )}

      {screen === S.THANKS && <ThankYouScreen onRestart={handleRestart} />}
    </>
  );
}
