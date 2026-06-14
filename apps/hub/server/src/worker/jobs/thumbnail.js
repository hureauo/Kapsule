import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeThumbnail } from '../ffmpeg.js';
import { openEventDb } from '../../eventStore.js';

/**
 * Job 'thumbnail' : génère un JPEG à t=1s dans events/<id>/derived/.
 * @param {{ event_id: string, video_id: string }} job
 * @param {string} dataDir
 */
export async function runThumbnail(job, dataDir) {
  const { event_id, video_id } = job;
  const edb = openEventDb(event_id, dataDir);

  const video = edb.prepare('SELECT filename FROM videos WHERE id = ?').get(video_id);
  if (!video) throw new Error(`Vidéo ${video_id} introuvable dans l'événement ${event_id}`);

  const derivedDir = join(dataDir, 'events', event_id, 'derived');
  mkdirSync(derivedDir, { recursive: true });

  const inputPath = join(dataDir, 'events', event_id, 'videos', video.filename);
  const outputPath = join(derivedDir, `${video_id}.jpg`);

  await makeThumbnail(inputPath, outputPath);

  edb.prepare(`
    INSERT INTO derived (video_id, thumbnail, probed_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(video_id) DO UPDATE SET
      thumbnail = excluded.thumbnail
  `).run(video_id, `${video_id}.jpg`);
}
