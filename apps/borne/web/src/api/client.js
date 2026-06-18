const TOKEN_KEY = 'admin_token';
const TECH_TOKEN_KEY = 'tech_token';
const GENERAL_TOKEN_KEY = 'kapsule_general_token';

// ── Gestion des tokens ────────────────────────────────────────────────────────

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getTechToken() { return localStorage.getItem(TECH_TOKEN_KEY); }

export function saveToken(token) { localStorage.setItem(TOKEN_KEY, token); }
export function saveTechToken(token) { localStorage.setItem(TECH_TOKEN_KEY, token); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
export function clearTechToken() { localStorage.removeItem(TECH_TOKEN_KEY); }

import { hasAdminRole, hasTechRole, getTokenEmail } from './roles.js';

export function hasAdminRoleInToken(token) { return hasAdminRole(token); }
export function hasTechRoleInToken(token) { return hasTechRole(token); }

export function getCurrentUserEmail() { return getTokenEmail(getToken()); }
export function getCurrentTechEmail() { return getTokenEmail(getTechToken()); }

// Vérifie présence du token ET rôle suffisant
export function isAuthenticated() { return Boolean(getToken()) && hasAdminRole(getToken()); }
export function isTechAuthenticated() { return Boolean(getTechToken()) && hasTechRole(getTechToken()); }

// general_token : sessionStorage (durée d'onglet, pas de persistance) — preview seulement
export function getGeneralToken() { return sessionStorage.getItem(GENERAL_TOKEN_KEY); }
export function saveGeneralToken(token) { sessionStorage.setItem(GENERAL_TOKEN_KEY, token); }
export function clearGeneralToken() { sessionStorage.removeItem(GENERAL_TOKEN_KEY); }

// ── Wrappers fetch ────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

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

// Routes tech (préflight, synchro, clôture) — lisent tech_token (§11.19)
async function techApiFetch(path, options = {}) {
  const token = getTechToken();
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

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
  getEvent: () => apiFetch('/api/event'),
  getQuestions: () => apiFetch('/api/questions'),

  createSession: (guest_name) => {
    const generalToken = getGeneralToken();
    const opts = { method: 'POST', body: JSON.stringify({ guest_name, consent: true }) };
    if (generalToken) opts.headers = { Authorization: `Bearer ${generalToken}` };
    return fetch('/api/sessions', {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    }).then(async res => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error ?? `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  },
  getAnswers: (sessionId) => apiFetch(`/api/sessions/${sessionId}/answers`),
  completeSession: (sessionId) =>
    apiFetch(`/api/sessions/${sessionId}/complete`, { method: 'PUT' }),

  // ── Auth ──────────────────────────────────────────────────────────────────

  login: (email, password) =>
    apiFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // ── Routes client admin (requireAdmin = client OU tech) ───────────────────

  health: () => apiFetch('/api/health'), // public, pas d'auth requise

  listEvents: () => apiFetch('/api/events'),
  activateEvent: (id) =>
    apiFetch(`/api/events/${id}/activate`, { method: 'PUT' }),
  updateEventSettings: (id, settings) =>
    apiFetch(`/api/events/${id}/settings`, { method: 'PUT', body: JSON.stringify(settings) }),

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

  listVideos: (sessionId) =>
    apiFetch(`/api/videos${sessionId ? `?session_id=${sessionId}` : ''}`),
  deleteVideo: (id) => apiFetch(`/api/videos/${id}`, { method: 'DELETE' }),
  listSessions: () => apiFetch('/api/sessions'),

  // ── Routes tech admin (requireTech — tech_token) ──────────────────────────

  closeEvent: (id) =>
    techApiFetch(`/api/events/${id}/close`, { method: 'PUT' }),

  getPreflight: (clientTime) =>
    techApiFetch(`/api/preflight?client_time=${encodeURIComponent(clientTime)}`),

  getSyncStatus: () => techApiFetch('/api/sync/status'),
  getHubConfig: () => techApiFetch('/api/sync/hub-config'),
  triggerPull: () => techApiFetch('/api/sync/pull', { method: 'POST' }),
  triggerPushConfig: () => techApiFetch('/api/sync/push-config', { method: 'POST' }),
  triggerPush: (eventId) => techApiFetch(`/api/sync/push/${eventId}`, { method: 'POST' }),
  updateToken: (token) => techApiFetch('/api/sync/token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),
  purgeEvent: (eventId, confirm) =>
    techApiFetch(`/api/sync/purge/${eventId}`, {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),
};

// ── URLs de ressources (ajoutent ?token= pour <video src>, downloads, CSV) ───

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

// ── Upload vidéo invité via XHR (fetch n'expose pas upload.onprogress) ────────

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
