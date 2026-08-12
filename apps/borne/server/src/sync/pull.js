import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { sha256File } from '@kapsule/core/src/checksum.js';
import { isValidAssetFilename } from '@kapsule/core';
import { getRegistry, insertEvent, setActiveEvent, getActiveEvent, listStalePreviewEvents, deleteEvent } from '../registry.js';
import { hubFetchJson, hubFetchBuffer } from './hubClient.js';
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
  // Phase B : PAS d'activation ici — pullEvent() est maintenant appelé pour
  // plusieurs événements par pullMyEvents() ; puller B ne doit jamais basculer
  // le kiosque hors de A si A est live. L'activation est portée explicitement
  // par l'appelant (pullMyEvent pour une preview, un choix humain sinon).

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

  // 6. Assets du design (§9bis). Seul contenu binaire du bundle : il ne transite
  // pas dans le JSON mais via un endpoint dédié, fichier par fichier, chacun
  // vérifié par checksum. Un mismatch fait ÉCHOUER le pull (invariant §11.27) —
  // mieux vaut pas de design du tout qu'un fichier corrompu servi au kiosque.
  //
  // En cas d'échec, on retire aussi `event_meta.design` : sinon le kiosque
  // servirait un design dont les images sont absentes (404 à l'affichage). Sans
  // la clé, il retombe proprement sur le thème figé.
  try {
    await pullDesignAssets(hubEventId, eventDir, bundle.design_assets ?? []);
  } catch (err) {
    dropDesignMeta(eventDir);
    throw err;
  }

  return { ok: true, eventId: hubEventId, questions: bundle.questions.length };
}

function dropDesignMeta(eventDir) {
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  try {
    edb.prepare("DELETE FROM event_meta WHERE key = 'design'").run();
  } finally {
    edb.close();
  }
}

async function pullDesignAssets(hubEventId, eventDir, assets) {
  const designDir = join(eventDir, 'design');

  // Le dossier est reconstruit à chaque pull : un asset d'un design précédent ne
  // doit pas survivre à un changement (ou à un retrait) de design côté Hub.
  rmSync(designDir, { recursive: true, force: true });
  if (assets.length === 0) return;
  mkdirSync(designDir, { recursive: true });

  for (const asset of assets) {
    // Le filename vient du bundle, donc du réseau : le valider AVANT de construire
    // un chemin avec. Sans ça, un `../db.sqlite` écraserait la base de l'événement.
    // Le Hub est de confiance, mais on ne s'appuie pas là-dessus pour une écriture.
    if (!isValidAssetFilename(asset.filename)) {
      rmSync(designDir, { recursive: true, force: true });
      throw new Error(`Nom d'image invalide dans le bundle : ${asset.filename} — pull interrompu`);
    }

    const dest = join(designDir, asset.filename);
    const buf = await hubFetchBuffer(
      `/api/sync/events/${hubEventId}/design/${encodeURIComponent(asset.filename)}`,
    );
    writeFileSync(dest, buf);

    const actual = await sha256File(dest);
    if (actual !== asset.checksum) {
      rmSync(designDir, { recursive: true, force: true });
      throw new Error(
        `Checksum invalide pour l'image ${asset.filename} `
        + `(attendu ${asset.checksum}, reçu ${actual}) — pull interrompu`,
      );
    }
  }
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
    // Une preview n'a jamais qu'un seul événement en jeu : l'activer immédiatement
    // préserve le comportement historique (pullEvent ne le fait plus, Phase B).
    setActiveEvent(eventInfo.id);
    db.prepare('UPDATE local_events SET is_preview = ? WHERE id = ?')
      .run(eventInfo.is_preview ? 1 : 0, eventInfo.id);
    _setLastPull();
    return 1;
  }
  _setLastPull();
  return 0;
}

/**
 * Tire TOUS les événements assignés à ce token borne (Phase B — plusieurs
 * événements par machine, à la différence de pullMyEvent/token=événement).
 *
 * N'active JAMAIS un événement au détriment d'un autre déjà en cours : pullEvent()
 * ne pose plus active=1 lui-même. Seule exception, pour ne pas laisser une
 * borne fraîchement provisionnée bloquée sur l'écran de chargement sans
 * intervention humaine : si aucun événement n'est actif et qu'un seul pull a
 * réussi, il devient l'actif. Dès que plusieurs événements coexistent,
 * l'activation redevient un choix explicite (console /borne ou commande Hub
 * `activate_event`).
 */
export async function pullMyEvents(dataDir) {
  let events;
  try {
    const res = await hubFetchJson('/api/sync/borne/events');
    events = res.events ?? [];
  } catch (e) {
    if (e.status === 400) return { pulled: 0, results: [] }; // token preview envoyé par erreur sur cette route
    throw e;
  }

  const db = getRegistry();
  const results = [];
  for (const eventInfo of events) {
    const existing = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventInfo.id);
    // §11.10 : ne jamais écraser un événement en cours (sessions invités actives).
    if (existing && existing.status !== 'loaded') {
      results.push({ eventId: eventInfo.id, skipped: true, reason: `statut local ${existing.status}` });
      continue;
    }
    try {
      await pullEvent(eventInfo.id, dataDir);
      results.push({ eventId: eventInfo.id, ok: true });
    } catch (err) {
      results.push({ eventId: eventInfo.id, ok: false, error: err.message });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  if (!getActiveEvent() && succeeded.length === 1) {
    setActiveEvent(succeeded[0].eventId);
  }

  _setLastPull();
  return { pulled: succeeded.length, results };
}
