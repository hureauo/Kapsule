import React from 'react';

// Barre de progression BASSE — composant unique de navigation/progression du parcours
// (voir design/parcours-invite.md). Fusionne : pastilles d'état (cliquables),
// label « Question X / N » et barre de remplissage globale.
// Placée en bas de l'écran (zone du pouce sur iPad) ; le header haut a été retiré
// de RecordingScreen pour dégager la question et la caméra.
//
// Navigation v2 : plus de flèches ◀ ▶ — on navigue par les pastilles (onGo) ou
// depuis le récap. Voir design/parcours-invite.md §12.
//
// answers : tableau d'ids (ou d'objets {question_id}) des questions déjà répondues.
// locked  : désactive les interactions (ex. pendant l'enregistrement/upload).
export default function QuestionNav({ questions, currentIndex, answers = [], onGo, locked = false }) {
  const answeredSet = new Set(answers.map ? answers.map((a) => a.question_id ?? a) : answers);
  const total = questions.length;
  const fillPct = ((currentIndex + 1) / total) * 100;

  return (
    <nav className="question-nav" aria-label="Navigation questions">
      {/* Barre de remplissage globale (progression dans le parcours) */}
      <div className="question-nav__progress" aria-hidden="true">
        <div className="question-nav__progress-fill" style={{ width: `${fillPct}%` }} />
      </div>

      <div className="question-nav__row">
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
              disabled={locked}
            />
          ))}
        </div>

        <span className="question-nav__label">
          Question {currentIndex + 1} / {total}
        </span>
      </div>
    </nav>
  );
}
