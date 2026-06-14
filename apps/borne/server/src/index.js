import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { openRegistry, getActiveEvent } from './registry.js';
import { makeAuthRouter, requireAdmin } from './middleware/auth.js';
import { makeEventsRouter } from './routes/events.js';
import { makeQuestionsRouter } from './routes/questions.js';
import { makeSessionsRouter } from './routes/sessions.js';
import { makeVideosRouter } from './routes/videos.js';
import { makeSyncRouter } from './routes/sync.js';

export function createApp(dataDir, cfg = config) {
  openRegistry(dataDir);

  const app = express();
  app.use(express.json());

  const routerCfg = { ...cfg, requireAdmin: requireAdmin(cfg) };
  app.post('/api/admin/login', makeAuthRouter(cfg));
  app.use('/api', makeEventsRouter(dataDir, routerCfg));
  app.use('/api', makeQuestionsRouter(dataDir, routerCfg));
  app.use('/api', makeSessionsRouter(dataDir, routerCfg));
  app.use('/api', makeVideosRouter(dataDir, routerCfg));
  app.use('/api', makeSyncRouter(dataDir, routerCfg));

  app.get('/api/health', async (req, res, next) => {
    try {
      const stats = await statfs(dataDir);
      const free_bytes = stats.bfree * stats.bsize;
      const total_bytes = stats.blocks * stats.bsize;
      const activeEvent = getActiveEvent();
      res.json({ ok: true, activeEvent: activeEvent?.id ?? null, disk: { free_bytes, total_bytes } });
    } catch (err) {
      next(err);
    }
  });

  // Error handler global — toujours en dernier, signature à 4 paramètres obligatoire pour Express
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      console.error(`[borne] ${req.method} ${req.path} →`, err);
      return res.status(status).json({ error: 'Erreur interne du serveur' });
    }
    res.status(status).json({ error: err.message ?? 'Erreur interne' });
  });

  return app;
}

// Point d'entrée réel — n'est pas exécuté lors des tests (import direct de createApp)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  mkdirSync(config.dataDir, { recursive: true });
  const app = createApp(config.dataDir);
  app.listen(config.port, () => {
    console.log(`borne-server démarré sur le port ${config.port}`);
  });
}
