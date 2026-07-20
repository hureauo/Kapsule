import React from 'react';
import { VIDEO_QUALITY, VIDEO_ORIENTATIONS, DEFAULT_VIDEO_ORIENTATION } from '@kapsule/core';

// welcome_title / welcome_subtitle viennent de GET /event (déjà résolus avec
// leurs fallbacks dynamiques par le serveur — voir design/parcours-invite.md §11).
// onVideoSettingsChange : callback ({quality?} | {orientation?}) → preview uniquement.
export default function StartScreen({ event, onStart, onVideoSettingsChange }) {
  const isPreview = !!(event?.is_preview);
  const currentQuality = event?.video_quality;
  const currentOrientation = event?.video_orientation ?? DEFAULT_VIDEO_ORIENTATION;
  // Les dimensions affichées dépendent de l'orientation courante.
  const presets = VIDEO_QUALITY[currentOrientation] ?? VIDEO_QUALITY[DEFAULT_VIDEO_ORIENTATION];

  // Image du design (§9bis, design4 : une seule image par écran, 3 états). Sans
  // design ou sans image configurée : mode 'none', rend exactement comme avant
  // l'introduction des designs.
  const design = event?.design ?? null;
  const image = design?.images?.start ?? { mode: 'none', filename: null };

  // L'image de fond n'est posée qu'en mode 'cover' : un fond ne doit pas
  // s'inviter quand le mode choisi est 'centered' ou 'none'.
  const coverStyle = image.mode === 'cover' && image.filename
    ? { backgroundImage: `url("${image.filename}")` }
    : undefined;

  const title = (
    <h1 className="start__title">
      {event?.welcome_title || event?.name || 'Kapsule'}
    </h1>
  );
  const tagline = event?.welcome_subtitle
    ? <p className="start__tagline">{event.welcome_subtitle}</p>
    : null;
  const imageEl = image.mode === 'centered' && image.filename
    ? <img className="screen__image" src={image.filename} alt="" />
    : null;

  const body = (
    <div className="start__body">
      {imageEl}
      {title}
      {tagline}

      {isPreview && onVideoSettingsChange && (
        <div className="preview-quality-picker" style={{ marginBottom: '20px', textAlign: 'center' }}>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', opacity: 0.75 }}>
            Qualité d'enregistrement (borne d'essai)
          </label>
          <select
            value={currentQuality ?? ''}
            onChange={(e) => onVideoSettingsChange({ quality: e.target.value })}
            style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '14px' }}
          >
            {Object.entries(presets).map(([key, q]) => (
              <option key={key} value={key}>
                {q.label} — {q.width}×{q.height}
              </option>
            ))}
          </select>

          <label style={{ display: 'block', margin: '10px 0 6px', fontSize: '13px', opacity: 0.75 }}>
            Format
          </label>
          <select
            value={currentOrientation}
            onChange={(e) => onVideoSettingsChange({ orientation: e.target.value })}
            style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '14px' }}
          >
            {VIDEO_ORIENTATIONS.map((o) => (
              <option key={o} value={o}>
                {o === 'portrait' ? 'Portrait (vertical)' : 'Paysage (horizontal)'}
              </option>
            ))}
          </select>
        </div>
      )}

      <button className="btn btn--primary btn--large" onClick={onStart}>
        Commencer
      </button>
    </div>
  );

  return (
    <div className={`screen screen--center start--${image.mode}`} style={coverStyle}>
      {body}
    </div>
  );
}
