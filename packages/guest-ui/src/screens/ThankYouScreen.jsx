import React, { useEffect, useState } from 'react';
import { imageWidthStyle } from '../design.js';

const AUTO_RETURN_S = 15;

// resolveAssetUrl : voir StartScreen.jsx (même principe d'injection).
export default function ThankYouScreen({ onRestart, thanksText, design, resolveAssetUrl = (f) => f }) {
  const [remaining, setRemaining] = useState(AUTO_RETURN_S);

  // Auto-retour à l'accueil après 15 s (spec §8)
  useEffect(() => {
    if (remaining <= 0) { onRestart(); return; }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, onRestart]);

  // Image du design (§9bis, design4 : une seule image par écran, 3 états). Sans
  // design ou sans image configurée : mode 'none' — rendu identique à celui
  // d'avant l'introduction des designs.
  const image = design?.images?.thanks ?? { mode: 'none', filename: null };
  const imageUrl = image.filename ? resolveAssetUrl(image.filename) : null;
  const coverStyle = image.mode === 'cover' && imageUrl
    ? { backgroundImage: `url("${imageUrl}")` }
    : undefined;
  const imageEl = image.mode === 'centered' && imageUrl
    ? <img className="screen__image" src={imageUrl} alt="" style={imageWidthStyle(image)} />
    : null;

  return (
    <div className={`screen screen--center thanks--${image.mode}`} data-color-target="bg" style={coverStyle}>
      <div className="thanks__body">
        {imageEl}
        <div className="done__icon" aria-hidden="true">🎬</div>
        <h2 className="screen__title">Merci !</h2>
        <p className="text--muted">
          {thanksText || 'Votre témoignage a bien été enregistré.'}
        </p>
        <p className="text--muted">Retour automatique dans {remaining} s…</p>
        <button className="btn btn--secondary btn--large" data-color-target="btn-secondary-bg" onClick={onRestart}>
          Terminer maintenant
        </button>
      </div>
    </div>
  );
}
