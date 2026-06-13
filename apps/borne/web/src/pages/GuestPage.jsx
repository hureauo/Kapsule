import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { DEFAULTS } from '@kapsule/core';
import StartScreen from '../components/guest/StartScreen.jsx';
import NameInput from '../components/guest/NameInput.jsx';
import QuestionNav from '../components/guest/QuestionNav.jsx';
import RecordingScreen from '../components/guest/RecordingScreen.jsx';
import RecapScreen from '../components/guest/RecapScreen.jsx';
import ThankYouScreen from '../components/guest/ThankYouScreen.jsx';

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

// ── Machine à états principale ────────────────────────────────────────────────
// États : loading | error | closed | start | name | questions | recap | thanks

const S = {
  LOADING: 'loading', ERROR: 'error', CLOSED: 'closed',
  START: 'start', NAME: 'name', QUESTIONS: 'questions',
  RECAP: 'recap', THANKS: 'thanks',
};

export default function GuestPage() {
  const [screen, setScreen] = useState(S.LOADING);
  const [event, setEvent] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');

  const [sessionId, setSessionId] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState([]); // réponses connues du serveur

  const loadEvent = useCallback(async () => {
    setScreen(S.LOADING);
    try {
      const [evtData, qData] = await Promise.all([api.getEvent(), api.getQuestions()]);
      setEvent(evtData);
      setQuestions(qData.filter((q) => q.enabled));
      setScreen(evtData.status === 'closed' ? S.CLOSED : S.START);
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
    } catch {
      // non bloquant
    }
  }, [sessionId]);

  // Timeout d'inactivité (§8) : hors rec/upload, retour idle après idle_timeout s
  // Désactivé sur questions (RecordingScreen gère son propre cycle) pour ne pas
  // interrompre un enregistrement ou un upload.
  const idleMs = (event?.idle_timeout ?? DEFAULTS.IDLE_TIMEOUT_S) * 1000;
  useEffect(() => {
    if (screen !== S.NAME) return; // uniquement sur name pour l'instant
    let timer = setTimeout(() => loadEvent(), idleMs);
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => loadEvent(), idleMs); };
    window.addEventListener('touchstart', reset);
    window.addEventListener('mousemove', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('touchstart', reset);
      window.removeEventListener('mousemove', reset);
    };
  }, [screen, idleMs, loadEvent]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleStart() { setScreen(S.NAME); }

  function handleSession(sid, name) {
    setSessionId(sid);
    setGuestName(name);
    setQuestionIndex(0);
    setAnswers([]);
    setScreen(S.QUESTIONS);
  }

  function handleQuestionNext() {
    refreshAnswers();
    if (questionIndex < questions.length - 1) {
      setQuestionIndex((i) => i + 1);
    } else {
      refreshAnswers();
      setScreen(S.RECAP);
    }
  }

  function handleQuestionBack() {
    refreshAnswers();
    if (questionIndex > 0) setQuestionIndex((i) => i - 1);
    else setScreen(S.NAME); // retour au formulaire nom (sans recréer de session)
  }

  function handleGoQuestion(i) {
    if (i >= 0 && i < questions.length) {
      refreshAnswers();
      setQuestionIndex(i);
    }
  }

  function handleRecapGo(i) {
    setQuestionIndex(i);
    setScreen(S.QUESTIONS);
  }

  function handleRecapFinish() { setScreen(S.THANKS); }

  function handleRestart() {
    setSessionId(null);
    setGuestName('');
    setQuestionIndex(0);
    setAnswers([]);
    loadEvent();
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────────

  if (screen === S.LOADING) return <LoadingScreen />;
  if (screen === S.ERROR)   return <ErrorScreen message={errorMsg} onRetry={loadEvent} />;
  if (screen === S.CLOSED)  return <ClosedScreen />;
  if (screen === S.START)   return <StartScreen event={event} onStart={handleStart} />;

  if (screen === S.NAME) {
    return (
      <NameInput
        event={event}
        onSession={handleSession}
        onBack={() => setScreen(S.START)}
      />
    );
  }

  if (screen === S.QUESTIONS && questions.length > 0) {
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
        {/* key=questionIndex force le remount complet à chaque changement de question */}
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
  }

  if (screen === S.QUESTIONS && questions.length === 0) {
    return (
      <div className="screen screen--center">
        <p className="text--muted">Aucune question configurée pour cet événement.</p>
        <button className="btn btn--primary" onClick={() => setScreen(S.RECAP)}>Terminer</button>
      </div>
    );
  }

  if (screen === S.RECAP) {
    return (
      <RecapScreen
        questions={questions}
        answers={answers}
        sessionId={sessionId}
        onGo={handleRecapGo}
        onFinish={handleRecapFinish}
      />
    );
  }

  if (screen === S.THANKS) {
    return <ThankYouScreen onRestart={handleRestart} />;
  }

  return null;
}
