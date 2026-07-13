import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import {
  getDb,
  listUsers, insertUser, getUserById, updateUser,
  createRegistrationToken,
  insertBoxToken, listBoxTokensByEvent, listAllBoxTokens, getBoxTokenById, deleteBoxToken, updateBoxToken,
  getEvent, listEventUsers, upsertEventUser, deleteEventUser,
  countSuperusers, insertEmailLog, listEmailLogs,
} from '../registry.js';
import { config } from '../config.js';
import { requireUser } from '../middleware/auth.js';
import { openEventDb } from '../eventStore.js';
import { META_KEYS } from '../eventConfig.js';
import { buildRegistrationUrl, maskEmail } from '../email/url.js';

const META_HASH_KEYS = META_KEYS;

function configHash(questions, meta) {
  const q = questions.map(({ text, max_duration, countdown, order_index, enabled }) =>
    ({ text, max_duration, countdown, order_index, enabled })
  );
  const m = Object.fromEntries(META_HASH_KEYS.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
  return createHash('sha256').update(JSON.stringify({ questions: q, meta: m })).digest('hex').slice(0, 8);
}

function requireSuperuser(req, res, next) {
  if (req.user.role !== 'superuser') return res.status(403).json({ error: 'Réservé aux superusers' });
  next();
}

/** Calcule récursivement la taille d'un dossier en octets. */
function dirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else {
        try { total += statSync(full).size; } catch { /* fichier disparu */ }
      }
    }
  } catch { /* dossier absent */ }
  return total;
}

export function makeAdminRouter(dataDir, { mailer } = {}) {
  const router = Router();
  router.use(requireUser, requireSuperuser);

  // Durcissement : chaque send-registration déclenche un envoi SMTP sortant + crée un
  // token. Même réservée aux superusers, une session abusée pourrait servir
  // d'amplificateur d'envoi → plafond. Instancié par routeur (état en mémoire isolé
  // entre suites de tests). 20/heure suffit largement à un usage admin normal.
  const sendRegistrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop d\'envois, réessayez plus tard.' },
  });

  // ── Gestion des comptes clients ─────────────────────────────────────────────

  // POST /api/admin/users — crée un compte client sans mot de passe + lien d'enregistrement
  router.post('/users', async (req, res, next) => {
    try {
      const { email, name } = req.body;
      if (!email || !email.trim()) return res.status(400).json({ error: 'email requis' });

      const db = getDb();
      let result;
      try {
        result = insertUser(db, { email: email.trim(), name: name?.trim() ?? null, role: 'client' });
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email déjà utilisé' });
        throw e;
      }

      const userId = result.lastInsertRowid;
      const { token } = createRegistrationToken(db, { user_id: userId });
      const registration_url = buildRegistrationUrl(req, token);
      const user = getUserById(db, userId);
      const { password_hash: _, ...safeUser } = user;

      res.status(201).json({ user: { ...safeUser, has_password: false }, registration_url });
    } catch (err) { next(err); }
  });

  // GET /api/admin/users — liste des comptes clients
  router.get('/users', (req, res) => {
    const db = getDb();
    const users = listUsers(db).map(({ password_hash, ...u }) => ({
      ...u,
      has_password: password_hash != null,
    }));
    res.json(users);
  });

  // PUT /api/admin/users/:id — désactiver/réactiver, renommer, changer le rôle global
  router.put('/users/:id', (req, res) => {
    const db = getDb();
    const user = getUserById(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const { active, name, role } = req.body;
    const fields = {};
    if (active !== undefined) fields.active = active ? 1 : 0;
    if (name !== undefined) fields.name = name?.trim() ?? null;

    if (role !== undefined) {
      if (!['superuser', 'client'].includes(role)) {
        return res.status(400).json({ error: 'Rôle invalide : superuser ou client attendu' });
      }
      // Garde-fou : interdire l'auto-modification de rôle
      if (String(req.user.sub) === String(req.params.id)) {
        return res.status(403).json({ error: 'Impossible de modifier son propre rôle' });
      }
      // Garde-fou : interdire de rétrograder le dernier superuser actif
      if (role === 'client' && user.role === 'superuser') {
        if (countSuperusers(db) <= 1) {
          return res.status(409).json({ error: 'Impossible de rétrograder le dernier superuser' });
        }
      }
      fields.role = role;
    }

    updateUser(db, req.params.id, fields);
    const updated = getUserById(db, req.params.id);
    const { password_hash: _, ...safe } = updated;
    res.json({ ...safe, has_password: updated.password_hash != null });
  });

  // POST /api/admin/users/:id/registration-link — génère un nouveau lien
  router.post('/users/:id/registration-link', async (req, res, next) => {
    try {
      const db = getDb();
      const user = getUserById(db, req.params.id);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      const { token } = createRegistrationToken(db, { user_id: user.id });
      const registration_url = buildRegistrationUrl(req, token);
      res.json({ registration_url });
    } catch (err) { next(err); }
  });

  // POST /api/admin/users/:id/send-registration — génère un lien ET l'envoie par email.
  // Envoi SYNCHRONE + journalisé dans email_logs. Renvoie TOUJOURS registration_url
  // (fallback copiable) + email_sent : un échec SMTP ne fait jamais échouer la requête.
  router.post('/users/:id/send-registration', sendRegistrationLimiter, async (req, res, next) => {
    try {
      const db = getDb();
      const user = getUserById(db, req.params.id);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      const { token } = createRegistrationToken(db, { user_id: user.id });
      const registration_url = buildRegistrationUrl(req, token);

      let email_sent = false;
      try {
        const result = await mailer.sendRegistrationLink({
          to: user.email, name: user.name, url: registration_url,
        });
        email_sent = result.ok === true;
        insertEmailLog(db, {
          recipient_email: user.email,
          type: 'registration',
          subject: result.subject ?? null,
          status: result.skipped ? 'skipped' : 'sent',
        });
      } catch (err) {
        console.error(`[hub][email] ❌ échec d'envoi à ${maskEmail(user.email)} (registration) : ${err.message}`);
        insertEmailLog(db, {
          recipient_email: user.email,
          type: 'registration',
          status: 'failed',
          error: err.message,
        });
      }

      res.json({ registration_url, email_sent });
    } catch (err) { next(err); }
  });

  // GET /api/admin/email-logs — journal des envois + état SMTP (onglet Gestion email).
  // On expose un diagnostic SMTP volontairement minimal : un booléen (configuré ou non),
  // l'hôte/port et l'expéditeur — JAMAIS l'utilisateur ni le mot de passe SMTP.
  router.get('/email-logs', (req, res) => {
    res.json({
      smtp: {
        configured: Boolean(config.smtpHost),
        host: config.smtpHost || null,
        port: config.smtpHost ? config.smtpPort : null,
        from: config.smtpFrom,
      },
      logs: listEmailLogs(getDb(), { limit: 100 }),
    });
  });

  // ── Tokens de borne (token = événement, §11.20) ──────────────────────────────

  // POST /api/admin/events/:id/tokens — génère un token ; token_clear stocké et retourné
  router.post('/events/:id/tokens', (req, res) => {
    const db = getDb();
    const event = getEvent(db, req.params.id);
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const { label, location, is_preview } = req.body;
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const result = insertBoxToken(db, {
      event_id: req.params.id,
      token_hash,
      token_clear: token,
      label: label?.trim() ?? null,
      location: location?.trim() ?? null,
      is_preview: is_preview ? 1 : 0,
    });
    res.status(201).json({
      id: result.lastInsertRowid,
      event_id: req.params.id,
      token_clear: token,
      label: label?.trim() ?? null,
      location: location?.trim() ?? null,
      is_preview: is_preview ? 1 : 0,
    });
  });

  // GET /api/admin/events/:id/tokens — liste + hash de la config Hub courante
  router.get('/events/:id/tokens', (req, res) => {
    const db = getDb();
    const tokens = listBoxTokensByEvent(db, req.params.id);
    let hub_config_hash = null;
    try {
      const edb = openEventDb(req.params.id, dataDir);
      const questions = edb.prepare('SELECT text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index, id').all();
      const metaRows = edb.prepare('SELECT key, value FROM event_meta').all();
      const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
      hub_config_hash = configHash(questions, meta);
    } catch { /* event sans DB encore */ }
    res.json({ tokens, hub_config_hash });
  });

  // GET /api/admin/tokens — tous les tokens (vue globale onglet Tokens)
  router.get('/tokens', (req, res) => {
    res.json(listAllBoxTokens(getDb()));
  });

  // DELETE /api/admin/tokens/:tokenId — révocation
  router.delete('/tokens/:tokenId', (req, res) => {
    const db = getDb();
    const result = deleteBoxToken(db, req.params.tokenId);
    if (result.changes === 0) return res.status(404).json({ error: 'Token introuvable' });
    res.status(204).end();
  });

  // PUT /api/admin/tokens/:tokenId — mise à jour label/location
  router.put('/tokens/:tokenId', (req, res) => {
    const db = getDb();
    const row = getBoxTokenById(db, req.params.tokenId);
    if (!row) return res.status(404).json({ error: 'Token introuvable' });
    updateBoxToken(db, req.params.tokenId, req.body);
    const updated = getBoxTokenById(db, req.params.tokenId);
    const { token_hash: _, ...safe } = updated;
    res.json(safe);
  });

  // ── Utilisateurs par événement (event_users) ────────────────────────────────

  // GET /api/admin/events/:id/users — liste des users assignés à un événement
  router.get('/events/:id/users', (req, res) => {
    const db = getDb();
    const event = getEvent(db, req.params.id);
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });
    res.json(listEventUsers(db, req.params.id).map(u => ({
      ...u,
      roles: JSON.parse(u.roles),
    })));
  });

  // POST /api/admin/events/:id/users — assigne un user avec ses rôles
  router.post('/events/:id/users', (req, res) => {
    const db = getDb();
    const event = getEvent(db, req.params.id);
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const { user_id, roles } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id requis' });
    if (!Array.isArray(roles) || roles.length === 0) return res.status(400).json({ error: 'roles requis (tableau non vide)' });

    const VALID_ROLES = ['admin_borne', 'tech_borne', 'general'];
    const invalid = roles.filter(r => !VALID_ROLES.includes(r));
    if (invalid.length > 0) return res.status(400).json({ error: `Rôles invalides : ${invalid.join(', ')}` });

    const user = getUserById(db, user_id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    upsertEventUser(db, { event_id: req.params.id, user_id, roles });
    res.status(201).json({ event_id: req.params.id, user_id, roles });
  });

  // DELETE /api/admin/events/:id/users/:userId — retire un user d'un événement
  router.delete('/events/:id/users/:userId', (req, res) => {
    const db = getDb();
    const result = deleteEventUser(db, { event_id: req.params.id, user_id: req.params.userId });
    if (result.changes === 0) return res.status(404).json({ error: 'Association introuvable' });
    res.status(204).end();
  });

  // GET /api/admin/overview
  router.get('/overview', async (req, res, next) => {
    try {
      const db = getDb();

      // Tous les événements (tous clients)
      const events = db.prepare(`
        SELECT e.id, e.name, e.status, e.created_at, e.pushed_at, e.processed_at
        FROM events e
        ORDER BY e.created_at DESC
      `).all();

      // Calcul de la taille disque par événement
      const eventsWithSize = events.map((ev) => ({
        ...ev,
        disk_bytes: dirSize(join(dataDir, 'events', ev.id)),
      }));

      // Disque libre du volume contenant dataDir
      const fsStats = await statfs(dataDir);
      const disk_free_bytes = fsStats.bfree * fsStats.bsize;
      const disk_total_bytes = fsStats.blocks * fsStats.bsize;

      // Jobs failed récents (20 derniers)
      const failed_jobs = db.prepare(`
        SELECT j.id, j.event_id, j.video_id, j.type, j.error, j.attempts,
               j.created_at, j.finished_at
        FROM jobs j
        WHERE j.status = 'failed'
        ORDER BY j.finished_at DESC
        LIMIT 20
      `).all();

      // Tokens de borne (box_tokens) avec last_seen_at
      const box_tokens_overview = db.prepare(`
        SELECT id, event_id, label, location, is_preview, last_seen_at, created_at
        FROM box_tokens
        ORDER BY created_at DESC
      `).all();

      res.json({
        events: eventsWithSize,
        disk: { free_bytes: disk_free_bytes, total_bytes: disk_total_bytes },
        failed_jobs,
        boxes: box_tokens_overview,
      });
    } catch (err) { next(err); }
  });

  return router;
}
