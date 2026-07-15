import React, { useEffect, useState } from 'react';

const AUTO_RETURN_S = 15;

export default function ThankYouScreen({ onRestart, thanksText, design }) {
  const [remaining, setRemaining] = useState(AUTO_RETURN_S);

  // Auto-retour à l'accueil après 15 s (spec §8)
  useEffect(() => {
    if (remaining <= 0) { onRestart(); return; }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, onRestart]);

  // Variante de disposition (§9bis). Sans design : 'centered' — rendu identique
  // à celui d'avant l'introduction des designs.
  const layout = design?.layouts?.thanks ?? 'centered';
  const background = design?.assets?.background ?? null;
  const coverStyle = layout === 'cover' && background
    ? { backgroundImage: `url("${background}")` }
    : undefined;

  return (
    <div className={`screen screen--center thanks--${layout}`} style={coverStyle}>
      <div className="thanks__body">
        <div className="done__icon" aria-hidden="true">🎬</div>
        <h2 className="screen__title">Merci !</h2>
        <p className="text--muted">
          {thanksText || 'Votre témoignage a bien été enregistré.'}
        </p>
        <p className="text--muted">Retour automatique dans {remaining} s…</p>
        <button className="btn btn--secondary btn--large" onClick={onRestart}>
          Terminer maintenant
        </button>
      </div>
    </div>
  );
}
