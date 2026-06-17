import React, { useRef } from 'react';

// Panneau slide-up de navigation entre les questions.
// Ouvert depuis QuestionNav (tap ou swipe up sur la barre basse).
// Fermé par : swipe down sur le panneau, tap sur l'overlay, ou sélection d'une question.
//
// onGo(i) : navigue vers la question i et ferme le panneau.
// onClose  : ferme sans naviguer.
export default function QuestionSheet({ questions, currentIndex, answers = [], onGo, onClose }) {
  const answeredSet = new Set(answers.map ? answers.map((a) => a.question_id ?? a) : answers);
  const touchStartY = useRef(null);

  function handleTouchStart(e) {
    touchStartY.current = e.touches[0].clientY;
  }

  function handleTouchEnd(e) {
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (dy > 60) onClose();
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="qsheet-overlay"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Navigation entre les questions"
    >
      <div
        className="qsheet"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Poignée visuelle indiquant le swipe-down */}
        <div className="qsheet__handle" aria-hidden="true" />

        <h3 className="qsheet__title">Vos réponses</h3>

        <ul className="qsheet__list">
          {questions.map((q, i) => {
            const isAnswered = answeredSet.has(q.id);
            const isCurrent  = i === currentIndex;
            // Les questions futures (non répondues, après la courante) ne sont pas accessibles
            const isFuture   = !isAnswered && !isCurrent;
            return (
              <li key={q.id}>
                <button
                  className={[
                    'qsheet__item',
                    isCurrent  ? 'qsheet__item--current'  : '',
                    isAnswered ? 'qsheet__item--answered' : '',
                    isFuture   ? 'qsheet__item--future'   : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onGo(i)}
                  disabled={isFuture}
                  aria-disabled={isFuture}
                >
                  <span className="qsheet__index">{i + 1}</span>
                  <span className="qsheet__text">{q.text}</span>
                  <span
                    className="qsheet__status"
                    aria-label={isAnswered ? 'Répondue' : isCurrent ? 'En cours' : 'À venir'}
                  >
                    {isAnswered ? '✓' : isCurrent ? '●' : '○'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
