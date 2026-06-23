import { getRole as roleFromToken } from './roles.js';

const TOKEN_KEY = 'hub_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function saveToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
export function isAuthenticated() { return !!getToken(); }

export function getRole() { return roleFromToken(getToken()); }

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers ?? {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.body) };
  }
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password } }),

  listEvents: () => apiFetch('/events'),
  createEvent: (name, event_date) => apiFetch('/events', { method: 'POST', body: { name, event_date } }),
  getEvent: (id) => apiFetch(`/events/${id}`),
  updateEvent: (id, fields) => apiFetch(`/events/${id}`, { method: 'PUT', body: fields }),
  setEventStatus: (id, status) => apiFetch(`/events/${id}/status`, { method: 'PUT', body: { status } }),
  deleteEvent: (id, confirm) => apiFetch(`/events/${id}`, { method: 'DELETE', body: { confirm } }),

  listQuestions: (eventId) => apiFetch(`/events/${eventId}/questions`),
  createQuestion: (eventId, q) => apiFetch(`/events/${eventId}/questions`, { method: 'POST', body: q }),
  updateQuestion: (eventId, id, fields) => apiFetch(`/events/${eventId}/questions/${id}`, { method: 'PUT', body: fields }),
  deleteQuestion: (eventId, id) => apiFetch(`/events/${eventId}/questions/${id}`, { method: 'DELETE' }),
  reorderQuestions: (eventId, order) => apiFetch(`/events/${eventId}/questions/reorder/batch`, { method: 'PUT', body: { order } }),

  getSyncInfo: (eventId) => apiFetch(`/events/${eventId}/sync`),

  // Galerie
  listVideos: (eventId) => apiFetch(`/events/${eventId}/videos`),
  deleteVideo: (eventId, videoId) => apiFetch(`/events/${eventId}/videos/${videoId}`, { method: 'DELETE' }),
  getArchiveStatus: (eventId) => fetch(`/api/events/${eventId}/archive`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  }),

  // Admin overview + tokens de borne
  getOverview: () => apiFetch('/admin/overview'),
  createBoxToken: (eventId, fields) => apiFetch(`/admin/events/${eventId}/tokens`, { method: 'POST', body: fields }),
  listBoxTokens: (eventId) => apiFetch(`/admin/events/${eventId}/tokens`),
  listAllTokens: () => apiFetch('/admin/tokens'),
  deleteBoxToken: (tokenId) => apiFetch(`/admin/tokens/${tokenId}`, { method: 'DELETE' }),
  updateBoxToken: (tokenId, fields) => apiFetch(`/admin/tokens/${tokenId}`, { method: 'PUT', body: fields }),
  assignEventOwner: (eventId, email) => apiFetch(`/events/${eventId}/owner`, { method: 'PUT', body: { email } }),
  previewStatus: (eventId) => apiFetch(`/events/${eventId}/preview/status`),
  previewStart:  (eventId) => apiFetch(`/events/${eventId}/preview/start`, { method: 'POST' }),
  previewStop:   (eventId) => apiFetch(`/events/${eventId}/preview/stop`,  { method: 'POST' }),
  generatePreviewToken: (eventId, expires_in) => apiFetch(`/events/${eventId}/preview/token`, { method: 'POST', body: { expires_in } }),
  listVersions:   (eventId) => apiFetch(`/events/${eventId}/versions`),
  getVersion:     (eventId, versionId) => apiFetch(`/events/${eventId}/versions/${versionId}`),
  restoreVersion: (eventId, versionId) => apiFetch(`/events/${eventId}/versions/${versionId}/restore`, { method: 'POST' }),

  // Admin : gestion des comptes clients
  listUsers: () => apiFetch('/admin/users'),
  createUser: (email, name) => apiFetch('/admin/users', { method: 'POST', body: { email, name } }),
  updateUser: (id, fields) => apiFetch(`/admin/users/${id}`, { method: 'PUT', body: fields }),
  createRegistrationLink: (id) => apiFetch(`/admin/users/${id}/registration-link`, { method: 'POST' }),
  // Génère un lien ET l'envoie par email ; renvoie { registration_url, email_sent }
  sendRegistration: (id) => apiFetch(`/admin/users/${id}/send-registration`, { method: 'POST' }),

  // Admin : utilisateurs assignés à un événement
  listEventUsers: (eventId) => apiFetch(`/admin/events/${eventId}/users`),
  addEventUser: (eventId, userId, roles) => apiFetch(`/admin/events/${eventId}/users`, { method: 'POST', body: { user_id: userId, roles } }),
  removeEventUser: (eventId, userId) => apiFetch(`/admin/events/${eventId}/users/${userId}`, { method: 'DELETE' }),

  // Auth : poser le mot de passe via lien d'enregistrement
  setPassword: (token, password) => apiFetch('/auth/set-password', { method: 'POST', body: { token, password } }),
  // Auth : demander un lien de réinitialisation (réponse toujours générique)
  forgotPassword: (email) => apiFetch('/auth/forgot-password', { method: 'POST', body: { email } }),

  // Galerie preview (proxy Hub → borne d'essai)
  listPreviewVideos: (eventId) => apiFetch(`/events/${eventId}/preview-videos`),
  previewVideoStreamUrl: (eventId, videoId) =>
    `/api/events/${eventId}/preview-videos/${videoId}/file?token=${getToken()}`,
  getPreviewStorage: (eventId) => apiFetch(`/events/${eventId}/preview-storage`),

  // URL directe avec ?token= pour téléchargements (invariant §11.2)
  videoStreamUrl: (eventId, videoId) => `/api/events/${eventId}/videos/${videoId}/file?token=${getToken()}`,
  videoDownloadUrl: (eventId, videoId) => `/api/events/${eventId}/videos/${videoId}/download?token=${getToken()}`,
  thumbnailUrl: (eventId, videoId) => `/api/events/${eventId}/videos/${videoId}/thumbnail?token=${getToken()}`,
  csvExportUrl: (eventId) => `/api/events/${eventId}/videos/export/csv?token=${getToken()}`,
  archiveUrl: (eventId) => `/api/events/${eventId}/archive?token=${getToken()}`,
};
