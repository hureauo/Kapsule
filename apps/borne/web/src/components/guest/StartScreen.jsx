import React from 'react';
import { VIDEO_QUALITY, mbPerMinFromKey } from '@kapsule/core';

// welcome_title / welcome_subtitle viennent de GET /event (déjà résolus avec
// leurs fallbacks dynamiques par le serveur — voir design/parcours-invite.md §11).
// onQualityChange : callback (qualityKey) → appelé uniquement en preview.
export default function StartScreen({ event, onStart, onQualityChange }) {
  const isPreview = !!(event?.is_preview);
  const currentQuality = event?.video_quality;

  return (
    <div className="screen screen--center">
      <h1 className="start__title">
        {event?.welcome_title || event?.name || 'Kapsule'}
      </h1>
      {event?.welcome_subtitle && (
        <p className="start__tagline">{event.welcome_subtitle}</p>
      )}

      {isPreview && onQualityChange && (
        <div className="preview-quality-picker" style={{ marginBottom: '20px', textAlign: 'center' }}>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', opacity: 0.75 }}>
            Qualité d'enregistrement (borne d'essai)
          </label>
          <select
            value={currentQuality ?? ''}
            onChange={(e) => onQualityChange(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '14px' }}
          >
            {Object.entries(VIDEO_QUALITY).map(([key, q]) => (
              <option key={key} value={key}>
                {q.label} — {q.width}×{q.height} · ≈{mbPerMinFromKey(key)} Mo/min
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
}
