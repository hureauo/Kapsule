import React from 'react';

export default function StartScreen({ event, onStart }) {
  return (
    <div className="screen screen--center">
      <h1 className="start__title">{event?.name ?? 'Kapsule'}</h1>
      {event?.consent_text && (
        <p className="start__tagline">{event.consent_text.split('\n')[0]}</p>
      )}
      <button className="btn btn--primary btn--large" onClick={onStart}>
        Commencer
      </button>
    </div>
  );
}
