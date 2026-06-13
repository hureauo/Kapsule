import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client.js';
import { DEFAULTS, LIMITS } from '@kapsule/core';

// ── Écrans ────────────────────────────────────────────────────────────────────

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

function IdleScreen({ event, onStart }) {
  const consentText = event?.consent_text ?? DEFAULTS.CONSENT_TEXT;
  return (
    <div className="screen screen--center">
      <h1 className="idle__title">{event?.name ?? 'Kapsule'}</h1>
      <p className="idle__consent">{consentText}</p>
      <button className="btn btn--primary btn--large" onClick={onStart}>
        Commencer
      </button>
    </div>
  );
}

function NameScreen({ onSubmit }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Merci d\'entrer votre prénom.'); return; }
    if (trimmed.length > 80) { setError('Prénom trop long (80 caractères max).'); return; }
    onSubmit(trimmed);
  }

  return (
    <div className="screen screen--center">
      <h2 className="screen__title">Comment vous appelez-vous ?</h2>
      <form className="name-form" onSubmit={handleSubmit}>
        <input
          className="name-form__input"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          placeholder="Votre prénom"
          maxLength={LIMITS.GUEST_NAME_MAX}
        />
        {error && <p className="text--error">{error}</p>}
        <button className="btn btn--primary btn--large" type="submit">
          Continuer
        </button>
      </form>
    </div>
  );
}

function QuestionRecapItem({ question, sessionId, index }) {
  return (
    <div className="recap__item">
      <span className="recap__index">{index + 1}</span>
      <span className="recap__question">{question.text}</span>
    </div>
  );
}

function DoneScreen({ onRestart }) {
  return (
    <div className="screen screen--center">
      <div className="done__icon" aria-hidden="true">🎬</div>
      <h2 className="screen__title">Merci !</h2>
      <p className="text--muted">Votre témoignage a été enregistré.</p>
      <button className="btn btn--secondary btn--large" onClick={onRestart}>
        Nouveau témoignage
      </button>
    </div>
  );
}

// Écran de résumé avant de terminer
function RecapScreen({ questions, sessionId, onFinish }) {
  const [loading, setLoading] = useState(false);

  async function handleFinish() {
    setLoading(true);
    try {
      await api.completeSession(sessionId);
    } finally {
      onFinish();
    }
  }

  return (
    <div className="screen screen--recap">
      <h2 className="screen__title">Votre témoignage</h2>
      <div className="recap__list">
        {questions.map((q, i) => (
          <QuestionRecapItem key={q.id} question={q} sessionId={sessionId} index={i} />
        ))}
      </div>
      <button
        className="btn btn--primary btn--large"
        onClick={handleFinish}
        disabled={loading}
      >
        {loading ? 'Finalisation…' : 'Terminer'}
      </button>
    </div>
  );
}

// ── Machine à états principale ────────────────────────────────────────────────

// États : loading | error | idle | name | questions | recap | done
const S = { LOADING: 'loading', ERROR: 'error', IDLE: 'idle', NAME: 'name',
            QUESTIONS: 'questions', RECAP: 'recap', DONE: 'done' };

export default function GuestPage() {
  const [screen, setScreen] = useState(S.LOADING);
  const [event, setEvent] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');

  // Session en cours
  const [sessionId, setSessionId] = useState(null);
  const [guestName, setGuestName] = useState('');

  const loadEvent = useCallback(async () => {
    setScreen(S.LOADING);
    try {
      const [evtData, qData] = await Promise.all([
        api.getEvent(),
        api.getQuestions(),
      ]);
      setEvent(evtData);
      setQuestions(qData.filter((q) => q.enabled));
      setScreen(S.IDLE);
    } catch (e) {
      setErrorMsg(e.message);
      setScreen(S.ERROR);
    }
  }, []);

  useEffect(() => {
    loadEvent();
  }, [loadEvent]);

  // Idle → consent/name
  function handleStart() {
    setScreen(S.NAME);
  }

  // Name → session créée → questions
  async function handleNameSubmit(name) {
    setGuestName(name);
    try {
      const session = await api.createSession(name);
      setSessionId(session.id);
      setScreen(S.QUESTIONS);
    } catch (e) {
      setErrorMsg(e.message);
      setScreen(S.ERROR);
    }
  }

  // Questions terminées → recap
  function handleQuestionsComplete() {
    setScreen(S.RECAP);
  }

  // Recap → done
  function handleRecapFinish() {
    setScreen(S.DONE);
  }

  // Done → reset
  function handleRestart() {
    setSessionId(null);
    setGuestName('');
    loadEvent();
  }

  // Timeout d'inactivité : retour à idle depuis name/questions
  const idleMs = (event?.idle_timeout ?? DEFAULTS.IDLE_TIMEOUT_S) * 1000;
  useEffect(() => {
    if (screen !== S.NAME && screen !== S.QUESTIONS) return;
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

  switch (screen) {
    case S.LOADING: return <LoadingScreen />;
    case S.ERROR:   return <ErrorScreen message={errorMsg} onRetry={loadEvent} />;
    case S.IDLE:    return <IdleScreen event={event} onStart={handleStart} />;
    case S.NAME:    return <NameScreen onSubmit={handleNameSubmit} />;
    case S.QUESTIONS:
      return (
        <QuestionsFlow
          questions={questions}
          sessionId={sessionId}
          onComplete={handleQuestionsComplete}
        />
      );
    case S.RECAP:
      return (
        <RecapScreen
          questions={questions}
          sessionId={sessionId}
          onFinish={handleRecapFinish}
        />
      );
    case S.DONE:    return <DoneScreen onRestart={handleRestart} />;
    default:        return null;
  }
}

// ── Flux questions (placeholder — sera complété en 1b.3 avec MediaRecorder) ──

function QuestionsFlow({ questions, sessionId, onComplete }) {
  const [index, setIndex] = useState(0);

  if (!questions.length) {
    return (
      <div className="screen screen--center">
        <p className="text--muted">Aucune question configurée.</p>
        <button className="btn btn--primary" onClick={onComplete}>Terminer</button>
      </div>
    );
  }

  const current = questions[index];
  const isLast = index === questions.length - 1;

  function handleNext() {
    if (isLast) onComplete();
    else setIndex((i) => i + 1);
  }

  return (
    <div className="screen screen--question">
      <div className="question__progress">
        {index + 1} / {questions.length}
      </div>
      <h2 className="question__text">{current.text}</h2>
      {/* Zone d'enregistrement — branchée en 1b.3 */}
      <div className="question__recorder-placeholder">
        <p className="text--muted">[Enregistrement — phase 1b.3]</p>
      </div>
      <button className="btn btn--primary btn--large" onClick={handleNext}>
        {isLast ? 'Terminer les réponses' : 'Question suivante'}
      </button>
    </div>
  );
}
