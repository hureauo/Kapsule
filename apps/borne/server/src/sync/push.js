import { statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sha256File } from '@kapsule/core/src/checksum.js';
import { config } from '../config.js';
import { getRegistry, updateEventStatus } from '../registry.js';
import { hubFetchJson } from './hubClient.js';

const MAX_ATTEMPTS = 5;
function backoffMs(n) { return Math.min(2000 * Math.pow(2, n - 1), 30000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// État partagé de la progression (lu par GET /api/sync/status)
const _state = { running: false, total: 0, done: 0, currentFile: null, lastError: null };
export function getPushState() { return { ..._state }; }

/** Test-only : force le flag running (pour vérifier les gardes qui en dépendent). */
export function _setPushRunning(v) { _state.running = v; }

/**
 * Checkpoint WAL + retourne le sha256 du db.sqlite.
 */
function checkpointAndHash(dbPath) {
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return sha256File(dbPath);
}

/**
 * Upload un fichier vers le Hub avec retry/backoff.
 * Appelle directement globalThis.fetch (et non hubFetch qui a son propre retry).
 */
async function uploadFileWithRetry(path, filePath, filename) {
  const url = `${config.hubUrl}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      const chunks = [];
      for await (const chunk of createReadStream(filePath)) chunks.push(chunk);
      const blob = new Blob(chunks);
      form.append('file', blob, filename);

      const res = await globalThis.fetch(url, {
        method: 'PUT',
        headers: { 'X-Box-Token': config.boxToken },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(
          new Error(`Hub ${res.status}: ${body.error ?? res.statusText}`),
          { status: res.status, body }
        );
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // Ne pas réessayer sur les erreurs client (4xx)
      if (err.status >= 400 && err.status < 500) throw err;
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
    }
  }
  throw Object.assign(
    new Error(`upload ${path} : ${MAX_ATTEMPTS} tentatives échouées — ${lastErr?.message}`),
    { cause: lastErr }
  );
}

/**
 * Pousse un événement vers le Hub.
 *
 * Précondition : event.status === 'closed' (vérifiée par l'appelant).
 * Idempotent : peut être relancé en cas d'interruption (le manifest dédoublonne).
 *
 * @param {string} eventId
 * @param {string} dataDir
 */
export async function pushEvent(eventId, dataDir) {
  const registry = getRegistry();
  const event = registry.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
  if (!event) throw Object.assign(new Error(`Événement ${eventId} inconnu`), { status: 404 });
  if (event.status !== 'closed') {
    throw Object.assign(
      new Error('Clôturez l\'événement avant le push'),
      { status: 409 }
    );
  }

  // Marquer running immédiatement (synchrone) avant tout await,
  // pour que GET /sync/status et le 2ème POST /push voient l'état correct dès le lancement.
  _state.running = true;
  _state.total = 0;
  _state.done = 0;
  _state.currentFile = null;
  _state.lastError = null;

  try {
  const eventDir = join(dataDir, 'events', eventId);
  const videosDir = join(eventDir, 'videos');
  const dbPath = join(eventDir, 'db.sqlite');

  // ── 1. Checkpoint WAL + sha256 de chaque vidéo + du db.sqlite ────────────

  // Lire la liste des vidéos depuis la BD événement
  const edb = new Database(dbPath, { readonly: true });
  const videos = edb.prepare('SELECT id, filename, size, checksum FROM videos').all();
  edb.close();

  // Checkpoint WAL (§11.8) — AVANT de checksummer le db.sqlite
  const dbChecksum = await checkpointAndHash(dbPath);
  const { size: dbSize } = statSync(dbPath);

  // ── 2. POST manifest → liste missing ─────────────────────────────────────

  const manifest = {
    files: videos.map(v => ({
      video_id: v.id,
      filename: v.filename,
      size: v.size,
      checksum: v.checksum,
    })),
    db: { size: dbSize, checksum: dbChecksum },
  };

  // Signale au Hub que l'événement est clôturé (best effort — ignore si déjà closed/pushed).
  // Nécessaire pour que le Hub accepte le manifest (qui exige status closed ou pushed).
  await hubFetchJson(`/api/sync/events/${eventId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'closed' }),
  }).catch(() => { /* best effort */ });

  const { missing } = await hubFetchJson(`/api/sync/events/${eventId}/manifest`, {
    method: 'POST',
    body: JSON.stringify(manifest),
  });

  // ── 3. Upload des vidéos manquantes ──────────────────────────────────────

  // Initialise push_state pour les nouvelles entrées
  const upsertState = registry.prepare(`
    INSERT INTO push_state (event_id, video_id, checksum)
    VALUES (?, ?, ?)
    ON CONFLICT(event_id, video_id) DO UPDATE SET checksum = excluded.checksum
  `);
  for (const v of videos) upsertState.run(eventId, v.id, v.checksum);

  _state.total = missing.length;

  {
    for (const videoId of missing) {
      const video = videos.find(v => v.id === videoId);
      if (!video) continue;

      _state.currentFile = video.filename;
      const filePath = join(videosDir, video.filename);

      await uploadFileWithRetry(
        `/api/sync/events/${eventId}/files/${videoId}`,
        filePath,
        video.filename
      );

      // Marque l'upload confirmé dans push_state
      registry.prepare(
        'UPDATE push_state SET uploaded_at = CURRENT_TIMESTAMP WHERE event_id = ? AND video_id = ?'
      ).run(eventId, videoId);

      _state.done++;
    }

    // ── 4. Upload du db.sqlite ──────────────────────────────────────────────

    _state.currentFile = 'db.sqlite';
    await uploadFileWithRetry(`/api/sync/events/${eventId}/db`, dbPath, 'db.sqlite');

    // ── 5. Finalize + mise à jour statut local ──────────────────────────────

    await hubFetchJson(`/api/sync/events/${eventId}/finalize`, { method: 'POST' });

    updateEventStatus(eventId, 'pushed');
    registry.prepare(
      'UPDATE local_events SET pushed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(eventId);

    _state.currentFile = null;
  }

  } catch (err) {
    // Expose l'erreur (y compris 401 token révoqué) dans _state pour GET /sync/status
    const msg = err.status === 401
      ? 'Token borne révoqué ou invalide — vérifier la configuration Hub'
      : (err.message ?? 'Erreur inconnue');
    _state.lastError = { message: msg, status: err.status ?? null };
    throw err;
  } finally {
    _state.running = false;
  }
}
