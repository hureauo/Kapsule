const TOKEN_KEY = 'admin_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated() {
  return Boolean(getToken());
}

// Wrapper fetch : attache Authorization si token présent, gère les erreurs HTTP
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── API publique (kiosque) ────────────────────────────────────────────────────

export const api = {
  // Événement actif
  getEvent: () => apiFetch('/api/event'),
  getQuestions: () => apiFetch('/api/questions'),

  // Sessions
  createSession: (guest_name) =>
    apiFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ guest_name, consent: true }),
    }),
  getAnswers: (sessionId) => apiFetch(`/api/sessions/${sessionId}/answers`),
  completeSession: (sessionId) =>
    apiFetch(`/api/sessions/${sessionId}/complete`, { method: 'PUT' }),

  // ── API admin ───────────────────────────────────────────────────────────────

  login: (password) =>
    apiFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  // Événements
  listEvents: () => apiFetch('/api/events'),
  createEvent: (data) =>
    apiFetch('/api/events', { method: 'POST', body: JSON.stringify(data) }),
  activateEvent: (id) =>
    apiFetch(`/api/events/${id}/activate`, { method: 'PUT' }),
  closeEvent: (id) =>
    apiFetch(`/api/events/${id}/close`, { method: 'PUT' }),
  updateEventSettings: (id, settings) =>
    apiFetch(`/api/events/${id}/settings`, { method: 'PUT', body: JSON.stringify(settings) }),

  // Questions
  listQuestions: () => apiFetch('/api/questions'),
  listAllQuestions: () => apiFetch('/api/questions/all'),
  createQuestion: (data) =>
    apiFetch('/api/questions', { method: 'POST', body: JSON.stringify(data) }),
  updateQuestion: (id, data) =>
    apiFetch(`/api/questions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteQuestion: (id) =>
    apiFetch(`/api/questions/${id}`, { method: 'DELETE' }),
  reorderQuestions: (order) =>
    apiFetch('/api/questions/reorder/batch', { method: 'PUT', body: JSON.stringify({ order }) }),

  // Vidéos admin
  listVideos: (sessionId) =>
    apiFetch(`/api/videos${sessionId ? `?session_id=${sessionId}` : ''}`),
  deleteVideo: (id) => apiFetch(`/api/videos/${id}`, { method: 'DELETE' }),

  // Sessions admin
  listSessions: () => apiFetch('/api/sessions'),

  // Preflight
  getPreflight: (clientTime) =>
    apiFetch(`/api/preflight?client_time=${encodeURIComponent(clientTime)}`),

  health: () => apiFetch('/api/health'),

  // Synchro
  getSyncStatus: () => apiFetch('/api/sync/status'),
  triggerPull: () => apiFetch('/api/sync/pull', { method: 'POST' }),
  triggerPush: (eventId) => apiFetch(`/api/sync/push/${eventId}`, { method: 'POST' }),
  purgeEvent: (eventId, confirm) =>
    apiFetch(`/api/sync/purge/${eventId}`, { method: 'POST', body: JSON.stringify({ confirm }) }),
};

// URLs de ressources — ajoutent ?token= pour <video src>, <a href>, CSV
// Le navigateur ne peut pas envoyer de header custom pour ces ressources (§11.2)
export function videoStreamUrl(videoId) {
  const t = getToken();
  return `/api/videos/${videoId}/file${t ? `?token=${t}` : ''}`;
}

export function videoDownloadUrl(videoId) {
  const t = getToken();
  return `/api/videos/${videoId}/download${t ? `?token=${t}` : ''}`;
}

export function csvExportUrl() {
  const t = getToken();
  return `/api/videos/export/csv${t ? `?token=${t}` : ''}`;
}

export function guestVideoUrl(sessionId, questionId) {
  return `/api/sessions/${sessionId}/videos/${questionId}/file`;
}

// Upload vidéo invité via XHR (seul XHR expose upload.onprogress — fetch ne le fait pas)
export function uploadVideo({ sessionId, questionId, questionText, blob, mimeType, onProgress }) {
  return new Promise((resolve, reject) => {
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([blob], `recording.${ext}`, { type: mimeType });
    const form = new FormData();
    form.append('video', file);
    form.append('session_id', sessionId);
    if (questionId != null) form.append('question_id', String(questionId));
    form.append('question_text', questionText);
    form.append('recorded_at', new Date().toISOString());

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('Accept', 'application/json');
    // Pas de token sur l'upload invité (route publique)

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        const body = JSON.parse(xhr.responseText || '{}');
        const err = new Error(body.error ?? `HTTP ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Erreur réseau'));
    xhr.send(form);
  });
}
