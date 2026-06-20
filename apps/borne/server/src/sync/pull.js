import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { getRegistry, insertEvent, setActiveEvent, listStalePreviewEvents, deleteEvent } from '../registry.js';
import { hubFetchJson } from './hubClient.js';
import { config } from '../config.js';

let _lastPull = null;
export function getLastPull() { return _lastPull; }
function _setLastPull() { _lastPull = new Date().toISOString(); }

/**
 * Tire un événement spécifique depuis le Hub et l'applique localement.
 *
 * Invariant §11.10 : le statut local est vérifié AU MOMENT d'appliquer la réponse,
 * pas au lancement. Si l'événement est passé en live entre la requête et la réponse,
 * on n'écrase pas les sessions en cours.
 */
export async function pullEvent(hubEventId, dataDir) {
  // 1. Requête Hub (peut échouer → lève)
  const bundle = await hubFetchJson(`/api/sync/events/${hubEventId}/bundle`);

  // 2. Vérifie le statut LOCAL au moment d'appliquer (invariant §11.10)
  const db = getRegistry();
  const existing = db.prepare('SELECT * FROM local_events WHERE id = ?').get(hubEventId);

  // §11.10 : sur borne physique, ne jamais écraser un événement live/closed
  // (sessions invités en cours). En preview, données jetables → toujours écraser.
  if (existing && existing.status !== 'loaded' && !config.previewMode) {
    return { skipped: true, reason: `statut local ${existing.status} — pull ignoré` };
  }

  // 3. Crée/met à jour l'event local
  const eventDir = join(dataDir, 'events', hubEventId);
  mkdirSync(eventDir, { recursive: true });
  mkdirSync(join(eventDir, 'videos'), { recursive: true });

  if (!existing) {
    insertEvent({ id: hubEventId, name: bundle.event.name, origin: 'hub', status: 'loaded' });
  }
  setActiveEvent(hubEventId);

  // 4. Met à jour pulled_at dans le registre
  db.prepare(
    'UPDATE local_events SET pulled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(hubEventId);

  // 5. Écrit les questions et event_meta dans la BD événement
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  try {
    // Vide les questions existantes et réinsère depuis le Hub (source de vérité)
    edb.transaction(() => {
      edb.prepare('DELETE FROM questions').run();
      const ins = edb.prepare(
        'INSERT INTO questions (id, text, max_duration, countdown, order_index, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const q of bundle.questions) {
        ins.run(q.id, q.text, q.max_duration, q.countdown, q.order_index, q.enabled ?? 1);
      }
    })();

    // Écrase event_meta depuis le Hub (source de vérité) — DELETE + INSERT
    // pour éviter de conserver des clés absentes du bundle (ex: thème changé côté hub)
    edb.transaction(() => {
      edb.prepare('DELETE FROM event_meta').run();
      if (bundle.event.meta && typeof bundle.event.meta === 'object') {
        const insMeta = edb.prepare('INSERT INTO event_meta (key, value) VALUES (?, ?)');
        for (const [k, v] of Object.entries(bundle.event.meta)) {
          insMeta.run(k, v);
        }
      }
    })();

    // Écrase event_users depuis le Hub — seuls admin_borne/tech_borne sont pullés.
    // Le rôle 'general' n'est plus inclus dans le bundle (auth proxiée vers Hub, §11.24).
    edb.transaction(() => {
      edb.prepare('DELETE FROM event_users').run();
      const borneUsers = (bundle.users ?? []).filter(u =>
        Array.isArray(u.roles) && u.roles.some(r => r !== 'general')
      );
      if (borneUsers.length > 0) {
        const insUser = edb.prepare(
          'INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)'
        );
        for (const u of borneUsers) {
          insUser.run(u.email, u.password_hash, JSON.stringify(u.roles));
        }
      }
    })();

    // Stocker requiresLogin dans event_meta pour que la borne puisse l'exposer
    // sans relire les event_users (qui ne contiennent plus les 'general').
    const requiresLogin = bundle.requiresLogin === true ? 'true' : 'false';
    edb.prepare("INSERT OR REPLACE INTO event_meta (key, value) VALUES ('requires_login', ?)").run(requiresLogin);
  } finally {
    edb.close();
  }

  return { ok: true, eventId: hubEventId, questions: bundle.questions.length };
}

/**
 * Tire l'événement unique associé à ce token depuis le Hub.
 * Remplace pullAssigned() — un token = un événement (invariant §11.20).
 *
 * Retourne 1 si un pull a eu lieu, 0 si aucun événement pullable (404 Hub).
 */
export async function pullMyEvent(dataDir) {
  let eventInfo;
  try {
    eventInfo = await hubFetchJson('/api/sync/event');
  } catch (e) {
    if (e.status === 404) return 0; // pas d'événement pullable pour ce token
    throw e;
  }

  const db = getRegistry();
  const existing = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventInfo.id);

  // En mode preview, toujours puller (pas de sessions réelles à protéger).
  // Sur borne physique, refuser si l'événement est live/closed (§11.10).
  const canPull = !existing || existing.status === 'loaded' || config.previewMode;
  if (canPull) {
    // En mode preview, purger les anciens événements preview avant d'appliquer le nouveau
    if (config.previewMode) {
      for (const staleId of listStalePreviewEvents(eventInfo.id)) {
        rmSync(join(dataDir, 'events', staleId), { recursive: true, force: true });
        deleteEvent(staleId);
      }
    }

    await pullEvent(eventInfo.id, dataDir);
    db.prepare('UPDATE local_events SET is_preview = ? WHERE id = ?')
      .run(eventInfo.is_preview ? 1 : 0, eventInfo.id);
    _setLastPull();
    return 1;
  }
  _setLastPull();
  return 0;
}
