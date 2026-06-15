import React from 'react';

// welcome_title / welcome_subtitle viennent de GET /event (déjà résolus avec
// leurs fallbacks dynamiques par le serveur — voir design/parcours-invite.md §11).
export default function StartScreen({ event, onStart }) {
  return (
    <div className="screen screen--center">
      <h1 className="start__title">
        {event?.welcome_title || event?.name || 'Kapsule'}
      </h1>
      {event?.welcome_subtitle && (
        <p className="start__tagline">{event.welcome_subtitle}</p>
      )}
      <button className="btn btn--primary btn--large" onClick={onStart}>
        Commencer
      </button>
    </div>
  );
}
