export const EVENT_STATUS = {
  DRAFT: 'draft',
  READY: 'ready',
  LOADED: 'loaded',
  LIVE: 'live',
  CLOSED: 'closed',
  PUSHED: 'pushed',
  PROCESSED: 'processed',
  PURGED: 'purged',
};

// Transitions légales (machine à états) — chaque statut ne peut avancer que vers le suivant
export const STATUS_ORDER = [
  'draft', 'ready', 'loaded', 'live', 'closed', 'pushed', 'processed', 'purged',
];

export const JOB_TYPES = {
  PROBE: 'probe',
  THUMBNAIL: 'thumbnail',
  ARCHIVE: 'archive',
};

export const JOB_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

export const LIMITS = {
  VIDEO_MAX_BYTES: 500 * 1024 * 1024, // 500 MB
  QUESTION_TEXT_MAX: 500,
  GUEST_NAME_MAX: 100,
  QUESTION_MAX_DURATION_S: 300,
  QUESTION_MIN_DURATION_S: 10,
  QUESTION_MAX_COUNTDOWN_S: 10,
  DISK_ALERT_BYTES: 10 * 1024 * 1024 * 1024, // 10 GB
};

// Thèmes visuels du parcours invité, sélectionnables depuis l'admin de la borne.
// 'cute' = Cutealism (défaut), 'dark' = sombre historique, 'modern' = blanc épuré,
// plat (sans transparence ni backdrop-filter — léger sur Raspberry/iPad). Voir design/.
export const THEMES = ['cute', 'dark', 'modern'];

export const DEFAULTS = {
  MAX_DURATION_S: 60,
  COUNTDOWN_S: 3,
  IDLE_TIMEOUT_S: 120,
  CONSENT_TEXT: "En participant, vous acceptez que vos vidéos soient enregistrées et transmises à l'organisateur de l'événement à des fins de souvenir personnel. Vos données ne seront pas partagées avec des tiers.",
  THEME: 'cute',
  // Textes du parcours invité, éditables en admin (event_meta). Chaîne vide =
  // « pas de valeur fixe », la route /event applique un fallback dynamique
  // (ex. welcome_title ← nom de l'événement). Voir design/parcours-invite.md §11.
  WELCOME_TITLE: '',            // défaut dynamique : nom de l'événement
  WELCOME_SUBTITLE: '',         // défaut dynamique : 1ʳᵉ ligne du consentement
  NAME_PROMPT: 'Comment vous appelez-vous ?',
  CONSENT_DETAILS: "Votre vidéo est enregistrée localement sur la borne, puis transmise de façon sécurisée à l'organisateur de l'événement. Elle sert uniquement à constituer un souvenir de l'événement. Vous pouvez demander son retrait à l'organisateur.",
  THANKS_TEXT: 'Votre témoignage a bien été enregistré.',
};

// Longueur max d'un champ texte du parcours (garde-fou anti-payload abusif).
export const TEXT_FIELD_MAX = 2000;

// Clés event_meta éditables comme texte libre, avec leur défaut associé.
// Source unique pour la validation backend et l'UI admin (panneau « Textes »).
export const TEXT_FIELDS = {
  welcome_title:    DEFAULTS.WELCOME_TITLE,
  welcome_subtitle: DEFAULTS.WELCOME_SUBTITLE,
  name_prompt:      DEFAULTS.NAME_PROMPT,
  consent_text:     DEFAULTS.CONSENT_TEXT,
  consent_details:  DEFAULTS.CONSENT_DETAILS,
  thanks_text:      DEFAULTS.THANKS_TEXT,
};
