// Journal d'initialisation en mémoire (Phase C) : les quelques dizaines
// dernières lignes de vie de la borne (démarrage, contact Hub, pulls), exposées
// sans authentification via GET /api/sync/pairing-status pour que l'écran
// d'onboarding pré-appairage montre une progression au technicien sur place.
// Volontairement non persisté : un redémarrage pendant la mise en route (rare)
// repart d'un journal vide, ce qui reste lisible pour l'usage visé.
const MAX_ENTRIES = 100;
let entries = [];

export function logInit(level, message) {
  entries.push({ at: new Date().toISOString(), level, message });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

export function getInitLog() {
  return entries;
}

/** Exposé pour les tests : réinitialise le singleton entre les suites. */
export function resetInitLog() {
  entries = [];
}
