import express from 'express';
import { statfs } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import rateLimit from 'express-rate-limit';
import { config, validateConfig } from './config.js';
import { openRegistry, getActiveEvent } from './registry.js';
import { makeAuthRouter, requireAdmin, requireTech } from './middleware/auth.js';
import { makeEventsRouter } from './routes/events.js';
import { makeQuestionsRouter } from './routes/questions.js';
import { makeSessionsRouter } from './routes/sessions.js';
import { makeVideosRouter, dirSize } from './routes/videos.js';
import { makeSyncRouter } from './routes/sync.js';
import { pullMyEvent, pullMyEvents } from './sync/pull.js';
import { resolveBorneIdentity } from './borneIdentity.js';
import { startHeartbeat } from './sync/heartbeat.js';
import { logInit } from './initLog.js';

export function createApp(dataDir, cfg = config) {
  openRegistry(dataDir);

  // Instancié par app pour éviter la pollution entre suites de tests (état en mémoire)
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes.' },
    skip: () => cfg.skipRateLimits === true,
  });

  const app = express();
  app.set('trust proxy', 1);
  // Jamais monté sur /api/videos : POST /videos est un upload multipart géré
  // par multer (voir routes/videos.js), qui parse le corps lui-même — un
  // parseur JSON global sur ce chemin n'a aucune utilité et ne doit pas
  // pouvoir interagir avec un flux binaire volumineux.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/videos')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });

  const routerCfg = { ...cfg, requireAdmin: requireAdmin(cfg), requireTech: requireTech(cfg) };
  app.post('/api/admin/login', loginLimiter, makeAuthRouter(cfg, dataDir));
  app.use('/api', makeEventsRouter(dataDir, routerCfg));
  app.use('/api', makeQuestionsRouter(dataDir, routerCfg));
  app.use('/api', makeSessionsRouter(dataDir, routerCfg));
  app.use('/api', makeVideosRouter(dataDir, routerCfg));
  app.use('/api', makeSyncRouter(dataDir, routerCfg));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/admin/health', routerCfg.requireAdmin, async (req, res, next) => {
    try {
      const stats = await statfs(dataDir);
      const free_bytes = stats.bfree * stats.bsize;
      const total_bytes = stats.blocks * stats.bsize;
      const activeEvent = getActiveEvent();
      const isPreview = !!(cfg.previewMode) || !!(activeEvent?.is_preview);
      const quota_bytes = cfg.maxDataBytes || 0;
      const used_bytes = dirSize(join(dataDir, 'events'));
      res.json({
        ok: true,
        activeEvent: activeEvent?.id ?? null,
        eventName: activeEvent?.name ?? null,
        isPreview,
        disk: { free_bytes, total_bytes },
        storage: { used_bytes, quota_bytes },
      });
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
  validateConfig(config, process.env.NODE_ENV);
  mkdirSync(config.dataDir, { recursive: true });
  const app = createApp(config.dataDir);
  // Après createApp() (qui a ouvert le registre) : lit/sème l'identité persistante
  // de borne physique — no-op pour une preview ou en mode autonome.
  resolveBorneIdentity();

  app.listen(config.port, async () => {
    const isPreview = config.previewMode;
    const isBornePhysique = Boolean(config.hubUrl && config.borneToken);
    const hostPort = config.port;
    const w = 52;
    const line = (s = '') => console.log(`│ ${s.padEnd(w - 2)} │`);

    // Pull one-shot au démarrage — bootstrappe le(s) événement(s) si aucun n'est
    // présent. Les pulls suivants sont déclenchés manuellement depuis /borne
    // (preview / token=événement) ou automatiquement par le heartbeat (borne
    // physique, PULL_INTERVAL_MS).
    let pullResult = null;
    if (isBornePhysique) {
      console.log('[borne] connexion au Hub (identité borne)…');
      logInit('info', `Démarrage — identité borne, Hub ${config.hubUrl}`);
      pullResult = await pullMyEvents(config.dataDir)
        .then(({ pulled }) => ({ pulled: pulled > 0 }))
        .catch(err => ({ error: err.message }));
      logInit(pullResult.error ? 'error' : 'info', pullResult.error
        ? `Pull initial échoué — ${pullResult.error}`
        : (pullResult.pulled ? 'Pull initial réussi' : 'Pull initial — aucun événement pullable'));
      startHeartbeat(config.dataDir);
    } else if (config.hubUrl && config.boxToken) {
      console.log('[borne] connexion au Hub…');
      logInit('info', `Démarrage — token d'événement, Hub ${config.hubUrl}`);
      pullResult = await pullMyEvent(config.dataDir).then(n => ({ pulled: n > 0 })).catch(err => ({ error: err.message }));
      logInit(pullResult.error ? 'error' : 'info', pullResult.error
        ? `Pull initial échoué — ${pullResult.error}`
        : (pullResult.pulled ? 'Pull initial réussi' : 'Pull initial — aucun événement pullable'));
    } else {
      logInit('info', 'Démarrage — mode autonome (aucun token configuré)');
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
    if (isBornePhysique) {
      line(`  Hub URL        : ${config.hubUrl}`);
      line(`  Borne token    : ${config.borneToken.slice(0, 8)}…`);
      line(`  Heartbeat      : toutes les ${Math.round(config.pullIntervalMs / 1000)}s`);
      if (pullResult?.error) {
        line(`  Synchro Hub    : ✗ erreur — ${pullResult.error.slice(0, 30)}`);
      } else if (pullResult?.pulled) {
        line(`  Synchro Hub    : ✓ pull réussi`);
      } else {
        line(`  Synchro Hub    : — aucun événement pullable`);
      }
    } else if (config.hubUrl && config.boxToken) {
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
