import React, { useRef } from 'react';

// Barre de progression BASSE — indicateur de parcours + déclencheur du panneau de navigation.
// Tap ou swipe vers le haut → ouvre QuestionSheet (panneau slide-up).
// Les dots sont purement visuels (non-interactifs) depuis v3 : la cible tactile
// est toute la barre, adaptée aux gros doigts sur iPad.
//
// answers : tableau d'ids (ou d'objets {question_id}) des questions déjà répondues.
// locked  : désactive l'ouverture du panneau (pendant rec/upload).
export default function QuestionNav({ questions, currentIndex, answers = [], onOpenSheet, locked = false }) {
  const answeredSet = new Set(answers.map ? answers.map((a) => a.question_id ?? a) : answers);
  const total = questions.length;
  const fillPct = ((currentIndex + 1) / total) * 100;
  const touchStartY = useRef(null);

  function handleTouchStart(e) {
    touchStartY.current = e.touches[0].clientY;
  }

  function handleTouchEnd(e) {
    if (locked) return;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (dy < -20) onOpenSheet();
  }

  return (
    <nav className="question-nav" aria-label="Progression du parcours">
      <div className="question-nav__progress" aria-hidden="true">
        <div className="question-nav__progress-fill" style={{ width: `${fillPct}%` }} />
      </div>

      {/* Toute la ligne est un bouton — cible tactile large pour iPad */}
      <button
        className="question-nav__row"
        onClick={() => !locked && onOpenSheet()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        disabled={locked}
        aria-label={`Question ${currentIndex + 1} sur ${total} — appuyer pour naviguer`}
        aria-haspopup="dialog"
      >
        <div className="question-nav__dots" aria-hidden="true">
          {questions.map((q, i) => (
            <span
              key={q.id}
              className={[
                'question-nav__dot',
                i === currentIndex ? 'question-nav__dot--current' : '',
                answeredSet.has(q.id) ? 'question-nav__dot--answered' : '',
              ].filter(Boolean).join(' ')}
            />
          ))}
        </div>

        <span className="question-nav__label">
          Question {currentIndex + 1} / {total}
        </span>

        {!locked && <span className="question-nav__chevron" aria-hidden="true">⌃</span>}
      </button>
    </nav>
  );
}
