import { THEMES, TEXT_FIELDS, QUALITY_KEYS, VIDEO_ORIENTATIONS } from '@kapsule/core';

// Clés event_meta gérées par applyEventConfig — source unique pour les routes config.
export const META_KEYS = ['theme', 'idle_timeout', 'video_quality', 'video_orientation', ...Object.keys(TEXT_FIELDS)];

/**
 * Applique meta + questions sur une event DB ouverte.
 *
 * mode 'overwrite' : remplace toutes les questions existantes, écrase toutes les meta.
 * mode 'merge'     : n'écrit que les meta absentes/vides ; n'ajoute que les questions au
 *                    texte inconnu ; n'efface rien.
 *
 * Thème invalide → ignoré silencieusement.
 * Texte de question tronqué à 500 caractères.
 */
export function applyEventConfig(edb, { mode, meta, questions }) {
  const upsert = edb.prepare(
    'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );

  if (meta && typeof meta === 'object') {
    for (const key of META_KEYS) {
      if (meta[key] === undefined) continue;
      if (mode === 'merge') {
        const existing = edb.prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value;
        if (existing && existing.trim() !== '') continue;
      }
      if (key === 'theme' && !THEMES.includes(meta[key])) continue;
      // video_quality / video_orientation sont aussi validés en amont dans la route
      // PUT /:eventId (→ 400). Ce skip silencieux protège les imports/push directs
      // qui contournent la route.
      if (key === 'video_quality' && !QUALITY_KEYS.includes(meta[key])) continue;
      if (key === 'video_orientation' && !VIDEO_ORIENTATIONS.includes(meta[key])) continue;
      upsert.run(key, String(meta[key]));
    }
  }

  if (Array.isArray(questions)) {
    if (mode === 'overwrite') edb.prepare('DELETE FROM questions').run();
    const existingTexts = new Set(edb.prepare('SELECT text FROM questions').all().map(q => q.text));
    const insert = edb.prepare(
      'INSERT INTO questions (text, max_duration, countdown, order_index, enabled) VALUES (?, ?, ?, ?, ?)'
    );
    const maxRow = edb.prepare('SELECT MAX(order_index) as m FROM questions').get();
    let nextOrder = (maxRow?.m ?? -1) + 1;
    for (const q of questions) {
      if (!q.text || typeof q.text !== 'string') continue;
      if (mode === 'merge' && existingTexts.has(q.text)) continue;
      insert.run(q.text.slice(0, 500), q.max_duration ?? 60, q.countdown ?? 3, nextOrder++, q.enabled !== undefined ? (q.enabled ? 1 : 0) : 1);
    }
  }
}
