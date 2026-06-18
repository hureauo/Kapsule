import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { openRegistry, getActiveEvent } from './registry.js';
import { makeAuthRouter, requireAdmin, requireTech } from './middleware/auth.js';
import { makeEventsRouter } from './routes/events.js';
import { makeQuestionsRouter } from './routes/questions.js';
import { makeSessionsRouter } from './routes/sessions.js';
import { makeVideosRouter } from './routes/videos.js';
import { makeSyncRouter } from './routes/sync.js';
import { pullMyEvent } from './sync/pull.js';

export function createApp(dataDir, cfg = config) {
  openRegistry(dataDir);

  const app = express();
  app.use(express.json());

  const routerCfg = { ...cfg, requireAdmin: requireAdmin(cfg), requireTech: requireTech(cfg) };
  app.post('/api/admin/login', makeAuthRouter(cfg, dataDir));
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
      const isPreview = !!(cfg.previewMode) || !!(activeEvent?.is_preview);
      res.json({ ok: true, activeEvent: activeEvent?.id ?? null, eventName: activeEvent?.name ?? null, isPreview, disk: { free_bytes, total_bytes } });
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
  app.listen(config.port, async () => {
    const isPreview = config.previewMode;
    const hostPort = config.hostPort ?? config.port;
    const w = 52;
    const line = (s = '') => console.log(`│ ${s.padEnd(w - 2)} │`);

    // Pull one-shot au démarrage — bootstrappe l'événement si aucun n'est présent.
    // Les pulls suivants sont déclenchés manuellement depuis /admin/tech.
    let pullResult = null;
    if (config.hubUrl && config.boxToken) {
      console.log('[borne] connexion au Hub…');
      pullResult = await pullMyEvent(config.dataDir).then(n => ({ pulled: n > 0 })).catch(err => ({ error: err.message }));
    }

    const activeEvent = getActiveEvent();

    console.log(`┌${'─'.repeat(w)}┐`);
    line(isPreview ? '  KAPSULE BORNE  [APERÇU / DÉMO]' : '  KAPSULE BORNE');
    console.log(`├${'─'.repeat(w)}┤`);
    if (isPreview) {
      line(`  Port hôte      : ${hostPort}  (frontend Nginx → ce backend)`);
      line(`  Accès client   : http://<serveur>:${hostPort}`);
      line(`  Mode démo      : push vers Hub désactivé (normal)`);
    } else {
      line(`  Port           : ${config.port}`);
      line(`  Interface web  : https://<ip-borne>  (via Nginx)`);
    }
    line(`  Health check   : http://localhost:${config.port}/api/health`);
    console.log(`├${'─'.repeat(w)}┤`);
    if (config.hubUrl && config.boxToken) {
      line(`  Hub URL        : ${config.hubUrl}`);
      line(`  Box token      : ${config.boxToken.slice(0, 8)}…`);
      if (pullResult?.error) {
        line(`  Synchro Hub    : ✗ erreur — ${pullResult.error.slice(0, 30)}`);
      } else if (pullResult?.pulled) {
        line(`  Synchro Hub    : ✓ pull réussi`);
      } else {
        line(`  Synchro Hub    : — aucun événement pullable`);
      }
    } else {
      line(`  Hub            : (mode autonome — HUB_URL non défini)`);
    }
    if (activeEvent) {
      line(`  Événement      : ${activeEvent.name.slice(0, 35)}`);
      line(`  Statut         : ${activeEvent.status}${activeEvent.is_preview ? '  [preview]' : ''}`);
    } else {
      line(`  Événement      : aucun actif`);
    }
    console.log(`├${'─'.repeat(w)}┤`);
    line(`  Quota disque   : ${config.maxDataBytes ? (config.maxDataBytes / 1024 / 1024 / 1024).toFixed(1) + ' Go' : 'illimité'}`);
    line(`  JWT secret     : ${config.jwtSecret === 'change-me' ? '⚠️  change-me (DEV)' : '✓ configuré'}`);
    console.log(`└${'─'.repeat(w)}┘`);
  });
}
