import { config } from '../config.js';
import { openRegistry, getDb } from '../registry.js';

const POLL_IDLE_MS = 5000;   // délai si aucun job disponible
const POLL_BUSY_MS = 500;    // délai entre deux jobs (évite le busy-loop, laisse la DB respirer)

// Les handlers sont chargés dynamiquement pour éviter de bloquer le démarrage
// si une dépendance optionnelle (ex: archiver) n'est pas encore installée.
let _handlers = null;
async function getHandlers() {
  if (!_handlers) {
    const [{ runProbe }, { runThumbnail }, { runArchive }] = await Promise.all([
      import('./jobs/probe.js'),
      import('./jobs/thumbnail.js'),
      import('./jobs/archive.js'),
    ]);
    _handlers = { probe: runProbe, thumbnail: runThumbnail, archive: runArchive };
  }
  return _handlers;
}

/** Permet d'injecter des handlers de substitution dans les tests. */
export function _setHandlers(handlers) { _handlers = handlers; }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Au démarrage : les jobs laissés en 'running' par un crash précédent sont orphelins.
 * Les repasser en 'pending' pour qu'ils soient retraités.
 */
export function recoverOrphans(db) {
  const result = db.prepare(
    "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  if (result.changes > 0) {
    console.log(`[worker] ${result.changes} job(s) orphelin(s) remis en pending`);
  }
}

/**
 * Tente de prendre un job pending de façon atomique.
 * Retourne le job mis en 'running', ou null si la file est vide.
 */
export function claimNextJob(db) {
  return db.transaction(() => {
    const job = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get();

    if (!job) return null;

    db.prepare(`
      UPDATE jobs
      SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
      WHERE id = ?
    `).run(job.id);

    return job;
  })();
}

/**
 * Après qu'un job passe en 'done', vérifie si tous les jobs de cet événement sont 'done'.
 * Si oui, passe l'événement en 'processed'.
 */
export function maybeMarkProcessed(db, eventId) {
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE event_id = ? AND status NOT IN ('done')
  `).get(eventId);

  if (pending.n === 0) {
    const updated = db.prepare(`
      UPDATE events
      SET status = 'processed', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pushed'
    `).run(eventId);
    if (updated.changes > 0) {
      console.log(`[worker] événement ${eventId} → processed`);
    }
  }
}

/**
 * Exécute un job et met à jour son statut.
 */
const KNOWN_TYPES = ['probe', 'thumbnail', 'archive'];

export async function processJob(db, job, dataDir) {
  if (!KNOWN_TYPES.includes(job.type)) {
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
          error = ?
      WHERE id = ?
    `).run(`Type de job inconnu : ${job.type}`, job.id);
    return;
  }

  const handlers = await getHandlers();
  const handler = handlers[job.type];

  try {
    console.log(`[worker] job #${job.id} ${job.type} event=${job.event_id} video=${job.video_id ?? '-'}`);
    await handler(job, dataDir);

    db.prepare(`
      UPDATE jobs
      SET status = 'done', finished_at = CURRENT_TIMESTAMP, error = NULL
      WHERE id = ?
    `).run(job.id);

    console.log(`[worker] job #${job.id} done`);
    maybeMarkProcessed(db, job.event_id);
  } catch (err) {
    const msg = err?.message ?? String(err);
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', finished_at = CURRENT_TIMESTAMP, error = ?
      WHERE id = ?
    `).run(msg.slice(0, 500), job.id);
    console.error(`[worker] job #${job.id} failed: ${msg}`);
  }
}

export async function loop(dataDir) {
  const db = getDb();
  recoverOrphans(db);

  console.log('[worker] démarré, en attente de jobs…');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = claimNextJob(db);
    if (job) {
      await processJob(db, job, dataDir);
      await sleep(POLL_BUSY_MS);
    } else {
      await sleep(POLL_IDLE_MS);
    }
  }
}

// Point d'entrée autonome (node src/worker/index.js)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  openRegistry(config.dataDir);
  loop(config.dataDir).catch((err) => {
    console.error('[worker] erreur fatale:', err);
    process.exit(1);
  });
}
