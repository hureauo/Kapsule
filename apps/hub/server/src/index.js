import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import argon2 from 'argon2';
import { config, validateConfig } from './config.js';
import { openRegistry, getDb, getUserByEmail, insertUser } from './registry.js';
import { makeAuthRouter } from './routes/auth.js';
import { requireUser } from './middleware/auth.js';
import { makeEventsRouter } from './routes/events.js';
import { makeQuestionsRouter } from './routes/questions.js';
import { makeAdminRouter } from './routes/admin.js';
import { makeSyncRouter } from './routes/sync.js';
import { makeGalleryRouter } from './routes/gallery.js';
import { makeVersionsRouter } from './routes/versions.js';

async function seedAdminIfNeeded() {
  if (!config.adminEmail || !config.adminPassword) return;
  const db = getDb();
  if (getUserByEmail(db, config.adminEmail)) return;
  const password_hash = await argon2.hash(config.adminPassword, { type: argon2.argon2id });
  insertUser(db, { email: config.adminEmail, password_hash, role: 'superuser' });
  console.log(`[hub] compte admin créé : ${config.adminEmail}`);
}

export function createApp(dataDir, opts = {}) {
  openRegistry(dataDir);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/auth', makeAuthRouter());
  app.use('/api/events', makeEventsRouter(dataDir));
  app.use('/api/events/:eventId/questions', makeQuestionsRouter(dataDir));
  app.use('/api/admin', makeAdminRouter(dataDir));
  app.use('/api/sync', makeSyncRouter(dataDir, opts.sync));
  app.use('/api/events/:eventId/versions', makeVersionsRouter(dataDir));
  app.use('/api/events/:eventId', makeGalleryRouter(dataDir));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/admin/health', requireUser, async (req, res, next) => {
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
  validateConfig(config, process.env.NODE_ENV);
  mkdirSync(config.dataDir, { recursive: true });
  const app = createApp(config.dataDir);
  seedAdminIfNeeded().then(() => {
    app.listen(config.port, () => {
      const w = 52;
      const line = (s = '') => console.log(`│ ${s.padEnd(w - 2)} │`);
      console.log(`┌${'─'.repeat(w)}┐`);
      line('  KAPSULE HUB');
      console.log(`├${'─'.repeat(w)}┤`);
      line(`  Port interne   : ${config.port}`);
      line(`  Interface web  : https://<domaine>  (via Nginx)`);
      line(`  Health check   : http://localhost:${config.port}/api/health`);
      console.log(`├${'─'.repeat(w)}┤`);
      line(`  Data dir       : ${config.dataDir}`);
      line(`  Admin email    : ${config.adminEmail || '(non configuré)'}`);
      line(`  Inscription    : ${config.allowRegister ? 'ouverte' : 'fermée (liens admin)'}`);
      line(`  JWT secret     : ${config.jwtSecret === 'change-me' ? '⚠️  change-me (DEV)' : '✓ configuré'}`);
      console.log(`└${'─'.repeat(w)}┘`);
    });
  });
}
