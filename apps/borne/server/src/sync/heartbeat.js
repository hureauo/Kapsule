import { statfs } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { getActiveEvent } from '../registry.js';
import { hubFetchJson } from './hubClient.js';
import { runCommand } from './commandExecutor.js';
import { logInit } from '../initLog.js';

let _timer = null;

// Lu une seule fois au chargement du module — informatif uniquement (aucune
// logique ne branche dessus), pour que l'onglet Bornes du Hub puisse repérer
// une borne restée sur un ancien build après un déploiement.
const AGENT_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

// Format : [borne/heartbeat] ✓/✗ battement  détail
function heartbeatLog(ok, detail = '') {
  const icon = ok ? '✓' : '✗';
  console.log([`[borne/heartbeat] ${icon} battement`, detail].filter(Boolean).join('  '));
}

/**
 * Un battement : télémétrie → Hub, exécution des commandes reçues, acquittement.
 * Best-effort et TOUJOURS silencieux à l'appelant (jamais de throw) — la borne
 * doit continuer à fonctionner offline, un Hub injoignable n'est jamais une
 * erreur pour l'opérateur sur place (même logique que le pull one-shot au boot).
 */
export async function beat(dataDir) {
  try {
    const stats = await statfs(dataDir).catch(() => null);
    const activeEvent = getActiveEvent();

    const { commands } = await hubFetchJson('/api/sync/borne/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        agent_version: AGENT_VERSION,
        disk: stats ? { free: stats.bfree * stats.bsize, total: stats.blocks * stats.bsize } : null,
        // clock_skew_ms calculé côté Hub (Date.now() - borne_time_ms) — la borne
        // n'a pas d'horloge de référence fiable sans RTC (§11.16).
        borne_time_ms: Date.now(),
        active_event_id: activeEvent?.id ?? null,
      }),
    });

    for (const command of commands ?? []) {
      const { status, result } = await runCommand(command, dataDir);
      await hubFetchJson(`/api/sync/borne/commands/${command.id}/result`, {
        method: 'POST',
        body: JSON.stringify({ status, result }),
      }).catch(() => { /* best effort — le Hub relira l'état réel au prochain battement */ });
    }

    heartbeatLog(true, commands?.length ? `commands=${commands.length}` : '');
    logInit('info', `Battement ✓${commands?.length ? ` — ${commands.length} commande(s)` : ''}`);
  } catch (err) {
    heartbeatLog(false, err.message);
    logInit('error', `Battement ✗ — ${err.message}`);
  }
}

/** Démarre la boucle périodique (PULL_INTERVAL_MS). No-op si déjà démarrée. */
export function startHeartbeat(dataDir) {
  if (_timer) return;
  _timer = setInterval(() => { beat(dataDir); }, config.pullIntervalMs);
  // unref() : ce timer ne doit jamais empêcher le process de s'arrêter proprement
  // (tests, arrêt du container) — cohérent avec le reste du code borne, qui ne
  // maintient aucune boucle de fond bloquante avant Phase B.
  _timer.unref?.();
}

/** Exposé pour les tests : réinitialise le singleton entre les suites. */
export function stopHeartbeat() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
