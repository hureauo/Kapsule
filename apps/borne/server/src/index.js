import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';

export function createApp(dataDir) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', async (req, res, next) => {
    try {
      const stats = await statfs(dataDir);
      const free_bytes = stats.bfree * stats.bsize;
      const total_bytes = stats.blocks * stats.bsize;

      // Événement actif : sera enrichi quand registry.js existera (phase 1a.1)
      res.json({ ok: true, activeEvent: null, disk: { free_bytes, total_bytes } });
    } catch (err) {
      next(err);
    }
  });

  // Error handler global — toujours en dernier, signature à 4 paramètres obligatoire pour Express
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
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
