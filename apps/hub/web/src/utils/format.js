// Formatters d'affichage — pures, sans dépendance browser (testables en Node).
// Regroupent ce qui était dupliqué inline dans AdminPage.jsx et VideoGallery.jsx.

// Octets → Ko / Mo / Go (vue admin, tailles d'événements et de disque).
export function formatBytes(b) {
  if (!b) return '0 o';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} Ko`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

// Octets → Ko / Mo (vidéos : on plafonne au Mo, '—' si absent).
export function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// Date ISO → locale fr-FR ('—' si absente).
export function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR');
}

// Timestamp SQLite (`datetime('now')` / `CURRENT_TIMESTAMP`) → locale fr-FR.
// SQLite écrit de l'UTC au format 'YYYY-MM-DD HH:MM:SS', SANS suffixe de zone :
// `new Date()` le lirait alors comme une heure LOCALE (décalage d'une à deux
// heures en France). On normalise en ISO + 'Z' avant de formater.
export function formatSqlDate(d) {
  if (!d) return '—';
  const iso = d.includes('T') ? d : `${d.replace(' ', 'T')}Z`;
  return new Date(iso).toLocaleString('fr-FR');
}

// Secondes → M:SS ('—' si null).
export function formatDuration(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Une vidéo est-elle verticale ? width/height viennent du job `probe` (table
// `derived`), et sont des dimensions D'AFFICHAGE : le worker applique la matrice
// de rotation, donc une vidéo mobile encodée en paysage mais tournée de 90° ressort
// bien avec height > width. Voir worker/ffmpeg.js.
//
// Une vidéo non encore sondée (probe en attente, ou échoué) n'a pas de dimensions :
// on répond false, donc le cadrage paysage par défaut. C'est le bon fallback — il
// correspond à l'orientation par défaut d'un événement.
export function isPortrait(video) {
  const { width, height } = video ?? {};
  if (!width || !height) return false;
  return height > width;
}
