import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { getRegistry, insertEvent } from '../registry.js';
import { hubFetchJson } from './hubClient.js';

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

  if (existing && existing.status !== 'loaded') {
    // Événement passé live/closed entre la requête et la réponse — ne pas écraser
    return { skipped: true, reason: `statut local ${existing.status} — pull ignoré` };
  }

  // 3. Crée/met à jour l'event local
  const eventDir = join(dataDir, 'events', hubEventId);
  mkdirSync(eventDir, { recursive: true });
  mkdirSync(join(eventDir, 'videos'), { recursive: true });

  if (!existing) {
    insertEvent({ id: hubEventId, name: bundle.event.name, origin: 'hub', status: 'loaded' });
  }

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

    // Écrit event_meta (consent_text, idle_timeout) si présent
    if (bundle.event.meta && Object.keys(bundle.event.meta).length > 0) {
      const upsertMeta = edb.prepare(
        'INSERT INTO event_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      edb.transaction(() => {
        for (const [k, v] of Object.entries(bundle.event.meta)) {
          upsertMeta.run(k, v);
        }
      })();
    }
  } finally {
    edb.close();
  }

  return { ok: true, eventId: hubEventId, questions: bundle.questions.length };
}

/**
 * Tire tous les événements assigned (ready/loaded) depuis le Hub
 * et les applique localement (nouveaux uniquement ou re-pull si loaded).
 *
 * Retourne le nombre d'événements traités.
 */
export async function pullAssigned(dataDir) {
  const assigned = await hubFetchJson('/api/sync/assigned');

  let pulled = 0;
  for (const ev of assigned) {
    const db = getRegistry();
    const existing = db.prepare('SELECT * FROM local_events WHERE id = ?').get(ev.id);

    // Pull si : pas encore présent localement, ou encore en statut 'loaded' (re-pull autorisé)
    if (!existing || existing.status === 'loaded') {
      await pullEvent(ev.id, dataDir);
      pulled++;
    }
  }

  return pulled;
}
