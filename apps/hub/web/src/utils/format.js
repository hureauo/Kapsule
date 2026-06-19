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

// Secondes → M:SS ('—' si null).
export function formatDuration(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
