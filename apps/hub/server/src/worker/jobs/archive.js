import { join } from 'node:path';
import { mkdirSync, createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import archiver from 'archiver';
import { getDb } from '../../registry.js';
import { openEventDb } from '../../eventStore.js';

/**
 * Job 'archive' : génère un ZIP (mode store) de toutes les vidéos de l'événement
 * dans events/<id>/derived/archive.zip.
 * Mode store = pas de compression (la vidéo est déjà compressée, §11.17).
 * @param {{ event_id: string }} job
 * @param {string} dataDir
 */
export async function runArchive(job, dataDir) {
  const { event_id } = job;
  const edb = openEventDb(event_id, dataDir);

  const videos = edb.prepare('SELECT id, filename FROM videos').all();

  const derivedDir = join(dataDir, 'events', event_id, 'derived');
  mkdirSync(derivedDir, { recursive: true });

  const zipPath = join(derivedDir, 'archive.zip');

  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { store: true });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const video of videos) {
      const filePath = join(dataDir, 'events', event_id, 'videos', video.filename);
      archive.append(createReadStream(filePath), { name: video.filename });
    }

    archive.finalize();
  });

  // Met à jour updated_at pour que les clients qui écoutent les événements voient la complétion.
  // La galerie détecte la présence de l'archive via le statut du job (done) et l'existence du fichier.
  getDb().prepare(
    'UPDATE events SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(event_id);
}
