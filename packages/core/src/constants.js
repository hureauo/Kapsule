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

export const DEFAULTS = {
  MAX_DURATION_S: 60,
  COUNTDOWN_S: 3,
  IDLE_TIMEOUT_S: 120,
  CONSENT_TEXT: "En participant, vous acceptez que vos vidéos soient enregistrées et transmises à l'organisateur de l'événement à des fins de souvenir personnel. Vos données ne seront pas partagées avec des tiers.",
};
