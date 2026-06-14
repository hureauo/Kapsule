import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { openRegistry } from './registry.js';
import { makeAuthRouter } from './routes/auth.js';
import { makeEventsRouter } from './routes/events.js';
import { makeQuestionsRouter } from './routes/questions.js';
import { makeAdminRouter } from './routes/admin.js';
import { makeSyncRouter } from './routes/sync.js';
import { makeGalleryRouter } from './routes/gallery.js';

export function createApp(dataDir, opts = {}) {
  openRegistry(dataDir);

  const app = express();
  app.use(express.json());

  app.use('/api/auth', makeAuthRouter());
  app.use('/api/events', makeEventsRouter(dataDir));
  app.use('/api/events/:eventId/questions', makeQuestionsRouter(dataDir));
  app.use('/api/admin', makeAdminRouter(dataDir));
  app.use('/api/sync', makeSyncRouter(dataDir, opts.sync));
  app.use('/api/events/:eventId', makeGalleryRouter(dataDir));

  app.get('/api/health', async (req, res, next) => {
    try {
      const stats = await statfs(dataDir);
      const free_bytes = stats.bfree * stats.bsize;
      const total_bytes = stats.blocks * stats.bsize;

      res.json({ ok: true, disk: { free_bytes, total_bytes } });
    } catch (err) {
      next(err);
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Erreurs multer (ex. fichier trop volumineux §S3/M2) → statut explicite plutôt que 500
    if (err.name === 'MulterError') {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: `Upload refusé : ${err.message}` });
    }
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      console.error(`[hub] ${req.method} ${req.path} →`, err);
      return res.status(status).json({ error: 'Erreur interne du serveur' });
    }
    res.status(status).json({ error: err.message ?? 'Erreur interne' });
  });

  return app;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  mkdirSync(config.dataDir, { recursive: true });
  const app = createApp(config.dataDir);
  app.listen(config.port, () => {
    console.log(`hub-server démarré sur le port ${config.port}`);
  });
}
