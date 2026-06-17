import { config } from '../config.js';
import { getRegistry } from '../registry.js';
import { hubFetch } from './hubClient.js';
import { pullMyEvent } from './pull.js';

let _timer = null;
let _lastPull = null; // ISO string du dernier pull réussi

export function getLastPull() { return _lastPull; }

/**
 * Envoie en best-effort le statut live/closed au Hub pour les événements locaux
 * dans ces états. Échec silencieux — retenté au prochain cycle.
 */
async function sendHeartbeats() {
  const db = getRegistry();
  const events = db.prepare(
    "SELECT * FROM local_events WHERE status IN ('live','closed')"
  ).all();

  for (const ev of events) {
    try {
      await hubFetch(`/api/sync/events/${ev.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: ev.status }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // best effort — silencieux
    }
  }
}

/**
 * Un cycle du pull automatique :
 * 1. Heartbeats best-effort pour les events live/closed
 * 2. Pull des events assigned si au moins un event local est en statut ≤ loaded
 *    (ou s'il n'y a aucun event local, pour bootstrapper)
 */
async function runCycle(dataDir) {
  if (!config.hubUrl || !config.boxToken) return; // mode autonome sans Hub

  await sendHeartbeats();

  const db = getRegistry();
  const hasLoaded = db.prepare(
    "SELECT 1 FROM local_events WHERE status = 'loaded' LIMIT 1"
  ).get();
  const hasNone = db.prepare('SELECT COUNT(*) as n FROM local_events').get().n === 0;

  if (hasLoaded || hasNone) {
    try {
      await pullMyEvent(dataDir);
      _lastPull = new Date().toISOString();
    } catch {
      // erreur réseau — silencieux, retenté au prochain cycle
    }
  }
}

/**
 * Démarre le pull automatique toutes les config.pullIntervalMs millisecondes.
 * Lance aussi un premier cycle immédiatement.
 */
export function startAutoPull(dataDir) {
  if (_timer !== null) return; // déjà démarré
  // Premier cycle immédiat (best effort, pas bloquant)
  runCycle(dataDir).catch(() => {});
  _timer = setInterval(() => runCycle(dataDir).catch(() => {}), config.pullIntervalMs);
}

export function stopAutoPull() {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}
