import React, { useState } from 'react';

// onFinishSession(sessionId) → Promise : injecté par l'appelant (borne :
// api.completeSession réel ; aperçu Hub : pas d'appel réseau) — même principe
// que NameInput/createSession (designUI, injection de dépendances).
export default function RecapScreen({ questions, answers, sessionId, onGo, onFinish, onFinishSession }) {
  const [loading, setLoading] = useState(false);
  const answeredSet = new Set((answers ?? []).map((a) => a.question_id ?? a));

  async function handleFinish() {
    setLoading(true);
    try {
      await onFinishSession(sessionId);
    } finally {
      onFinish();
    }
  }

  return (
    <div className="screen screen--recap">
      <h2 className="screen__title">Votre témoignage</h2>

      <div className="recap__list">
        {questions.map((q, i) => {
          const done = answeredSet.has(q.id);
          return (
            <button
              key={q.id}
              className={`recap__item recap__item--btn${done ? ' recap__item--done' : ''}`}
              onClick={() => onGo(i)}
            >
              <span className="recap__index">{i + 1}</span>
              <span className="recap__question">{q.text}</span>
              <span className="recap__status" aria-label={done ? 'Répondue' : 'Non répondue'}>
                {done ? '●' : '○'}
              </span>
            </button>
          );
        })}
      </div>

      <button
        className="btn btn--primary btn--large"
        onClick={handleFinish}
        disabled={loading}
      >
        {loading ? 'Finalisation…' : 'J\'ai terminé ✓'}
      </button>
    </div>
  );
}
