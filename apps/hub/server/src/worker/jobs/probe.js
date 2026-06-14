import { join } from 'node:path';
import { runFfprobe } from '../ffmpeg.js';
import { openEventDb } from '../../eventStore.js';

/**
 * Job 'probe' : sonde la vidéo et met à jour la table derived.
 * @param {{ event_id: string, video_id: string }} job
 * @param {string} dataDir
 */
export async function runProbe(job, dataDir) {
  const { event_id, video_id } = job;
  const edb = openEventDb(event_id, dataDir);

  const video = edb.prepare('SELECT filename FROM videos WHERE id = ?').get(video_id);
  if (!video) throw new Error(`Vidéo ${video_id} introuvable dans l'événement ${event_id}`);

  const filePath = join(dataDir, 'events', event_id, 'videos', video.filename);
  const { duration_s, width, height } = await runFfprobe(filePath);

  edb.prepare(`
    INSERT INTO derived (video_id, duration_s, width, height, probed_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(video_id) DO UPDATE SET
      duration_s = excluded.duration_s,
      width      = excluded.width,
      height     = excluded.height,
      probed_at  = excluded.probed_at
  `).run(video_id, duration_s, width, height);
}
