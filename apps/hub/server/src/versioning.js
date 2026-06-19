import { insertEventVersion, listEventVersions, getEventVersion, getUserById } from './registry.js';

// Résout l'email de l'auteur depuis req.user (le JWT ne contient que sub + role).
export function resolveAuthor(db, user) {
  if (!user) return null;
  const row = getUserById(db, user.sub);
  return row?.email ?? null;
}

// Lit l'état complet du contenu éditorial depuis une event DB ouverte.
export function readSnapshot(edb) {
  const metaRows = edb.prepare('SELECT key, value FROM event_meta').all();
  const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
  const questions = edb
    .prepare('SELECT text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index, id')
    .all();
  return { meta, questions };
}

// Génère un résumé lisible en comparant l'ancien et le nouveau snapshot.
function buildSummary(prev, next) {
  if (!prev) {
    return `Version initiale — ${next.questions.length} question(s)`;
  }

  const qPrev = prev.questions.length;
  const qNext = next.questions.length;
  const questionsChanged =
    qPrev !== qNext ||
    JSON.stringify(prev.questions) !== JSON.stringify(next.questions);

  const metaChanged =
    JSON.stringify(prev.meta) !== JSON.stringify(next.meta);

  if (!questionsChanged && !metaChanged) return 'Aucun changement';

  const parts = [];
  if (questionsChanged) {
    if (qPrev === qNext) parts.push('Questions modifiées');
    else parts.push(`Questions (${qPrev} → ${qNext})`);
  }
  if (metaChanged) {
    const changedKeys = Object.keys(next.meta).filter(k => next.meta[k] !== prev.meta?.[k]);
    if (changedKeys.includes('theme')) {
      parts.push(`Thème → ${next.meta.theme}`);
    } else {
      parts.push('Design / textes modifiés');
    }
  }
  return parts.join(' · ');
}

// Point d'entrée principal : capture un snapshot et l'insère si le contenu a changé.
// Renvoie la version insérée (ou null si rien n'a changé).
export function captureSnapshot(db, edb, { event_id, author = null, summaryOverride = null }) {
  const snapshot = readSnapshot(edb);

  const [lastRow] = listEventVersions(db, event_id);
  const prev = lastRow ? getEventVersion(db, lastRow.id).snapshot : null;

  const summary = summaryOverride ?? buildSummary(prev, snapshot);
  if (summary === 'Aucun changement') return null;

  insertEventVersion(db, { event_id, snapshot, summary, author });
  return summary;
}
