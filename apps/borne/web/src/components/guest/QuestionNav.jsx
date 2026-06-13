import React from 'react';

// Navigation ◀ ▶ + pastilles d'état par question.
// answers : Set ou tableau d'ids de questions déjà répondues (alimenté en 1c.1).
export default function QuestionNav({ questions, currentIndex, answers = [], onGo }) {
  const answeredSet = new Set(answers.map ? answers.map((a) => a.question_id ?? a) : answers);

  return (
    <nav className="question-nav" aria-label="Navigation questions">
      <button
        className="question-nav__arrow"
        aria-label="Question précédente"
        onClick={() => onGo(currentIndex - 1)}
        disabled={currentIndex === 0}
      >
        ◀
      </button>

      <div className="question-nav__dots">
        {questions.map((q, i) => (
          <button
            key={q.id}
            className={[
              'question-nav__dot',
              i === currentIndex ? 'question-nav__dot--current' : '',
              answeredSet.has(q.id) ? 'question-nav__dot--answered' : '',
            ].filter(Boolean).join(' ')}
            aria-label={`Question ${i + 1}${answeredSet.has(q.id) ? ' (répondue)' : ''}`}
            aria-current={i === currentIndex ? 'step' : undefined}
            onClick={() => onGo(i)}
          />
        ))}
      </div>

      <button
        className="question-nav__arrow"
        aria-label="Question suivante"
        onClick={() => onGo(currentIndex + 1)}
        disabled={currentIndex === questions.length - 1}
      >
        ▶
      </button>
    </nav>
  );
}
