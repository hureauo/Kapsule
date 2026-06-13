import { LIMITS, STATUS_ORDER } from './constants.js';

export function validateQuestion({ text, max_duration, countdown }) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return 'Le texte de la question est requis.';
  }
  if (text.length > LIMITS.QUESTION_TEXT_MAX) {
    return `Le texte ne doit pas dépasser ${LIMITS.QUESTION_TEXT_MAX} caractères.`;
  }
  if (max_duration !== undefined) {
    const d = Number(max_duration);
    if (!Number.isInteger(d) || d < LIMITS.QUESTION_MIN_DURATION_S || d > LIMITS.QUESTION_MAX_DURATION_S) {
      return `max_duration doit être un entier entre ${LIMITS.QUESTION_MIN_DURATION_S} et ${LIMITS.QUESTION_MAX_DURATION_S}.`;
    }
  }
  if (countdown !== undefined) {
    const c = Number(countdown);
    if (!Number.isInteger(c) || c < 0 || c > LIMITS.QUESTION_MAX_COUNTDOWN_S) {
      return `countdown doit être un entier entre 0 et ${LIMITS.QUESTION_MAX_COUNTDOWN_S}.`;
    }
  }
  return null;
}

export function validateGuestName(name) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return 'Le prénom est requis.';
  }
  if (name.length > LIMITS.GUEST_NAME_MAX) {
    return `Le prénom ne doit pas dépasser ${LIMITS.GUEST_NAME_MAX} caractères.`;
  }
  return null;
}

// Vérifie qu'une transition de statut est légale (avance uniquement)
export function assertStatus(current, next) {
  const from = STATUS_ORDER.indexOf(current);
  const to = STATUS_ORDER.indexOf(next);
  if (from === -1) throw new Error(`Statut inconnu : ${current}`);
  if (to === -1) throw new Error(`Statut inconnu : ${next}`);
  if (to <= from) throw new Error(`Transition invalide : ${current} → ${next}`);
}
