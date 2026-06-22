/**
 * previewGallery.js — Proxy Hub → backend borne d'essai (preview)
 *
 * Pendant la phase preview, les vidéos enregistrées sur la borne d'essai vivent
 * dans le container `preview-backend-<slug>` (réseau kapsule_hub_net). Elles ne
 * sont PAS dans le DATA_DIR du Hub (pas de push en PREVIEW_MODE).
 *
 * Ce router expose deux routes accessibles depuis le Hub :
 *   GET /preview-videos           — liste les vidéos (JSON relayé)
 *   GET /preview-videos/:id/file  — proxy Range-aware du fichier vidéo
 *
 * Auth vers la borne : JWT court (`admin_borne`, `event_id`) signé avec JWT_SECRET
 * partagé entre Hub et borne. Le `event_id` est re-vérifié côté borne →
 * cloisonnement cross-preview gratuit (§11 invariants).
 *
 * Le container est ciblé par son nom réel `preview-backend-<slug>` (DNS Docker sur
 * kapsule_hub_net), PAS par l'alias `borne-preview-backend` qui serait en collision
 * si plusieurs previews tournent simultanément.
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { requireUser, requireOwner } from '../middleware/auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Dérive le slug DNS-safe depuis l'eventId (même logique que provisioner.js).
 * Dupliqué ici pour éviter un couplage direct avec le module provisioner et
 * permettre de tester ce router sans docker injectable.
 */
function slugFor(eventId) {
  return createHash('sha256').update(eventId).digest('hex').slice(0, 8);
}

/**
 * URL de base du backend borne preview pour cet événement.
 * Le container est joignable par DNS Docker via son nom de container.
 */
function previewBackendBase(eventId) {
  return `http://preview-backend-${slugFor(eventId)}:3001`;
}

/**
 * Forge un JWT court pour les requêtes internes Hub → borne preview.
 * Durée 5 min — jamais exposé au client.
 *
 * On forge `tech_borne` plutôt que `admin_borne` parce que la hiérarchie de rôles
 * borne est asymétrique (§11.19) :
 *   - requireAdmin  accepte admin_borne OU tech_borne
 *   - requireTech   accepte UNIQUEMENT tech_borne
 * `POST /api/sync/pull` est gardé par requireTech → il faut tech_borne.
 * `event_id` dans le payload assure le cloisonnement cross-preview côté borne.
 */
function forgePreviewToken(eventId) {
  const secret = process.env.JWT_SECRET ?? 'change-me';
  return jwt.sign(
    { roles: ['tech_borne'], event_id: eventId },
    secret,
    { expiresIn: '5m' }
  );
}

// Timeout par défaut pour les requêtes vers la borne preview (ms).
// Une borne qui accepte la connexion TCP mais ne répond pas ferait pendre la requête
// indéfiniment sans ce garde-fou — critique en production.
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Effectue une requête HTTP vers le backend preview et retourne la réponse.
 * Remonte une erreur de connexion (ECONNREFUSED, ENOTFOUND) avec `code` conservé
 * pour pouvoir renvoyer un 503 propre au client.
 * Timeout à REQUEST_TIMEOUT_MS ms pour éviter les connexions pendantes.
 *
 * @param {string} urlStr     URL complète (ex. http://preview-backend-xxx:3001/videos)
 * @param {object} options    Options http.request (method, headers, …)
 * @returns {Promise<http.IncomingMessage>}
 */
function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        timeout: REQUEST_TIMEOUT_MS,
      },
      resolve
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('Borne preview : timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.end();
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * @param {{ resolveBase?: (eventId: string) => string }} opts
 *   `resolveBase` est injectable pour les tests (pointe sur un faux backend en mémoire).
 *   En production, la résolution par défaut cible `preview-backend-<slug>:3001` via DNS Docker.
 */
export function makePreviewGalleryRouter({ resolveBase } = {}) {
  const getBase = resolveBase ?? previewBackendBase;
  const router = Router({ mergeParams: true });

  // Tous les endpoints : authentification Hub + propriété de l'événement
  router.use(requireUser, requireOwner);

  // ── GET /api/events/:eventId/preview-videos ──────────────────────────────
  // Liste les vidéos enregistrées sur la borne d'essai (JSON relayé).
  // Renvoie 503 si le container preview est hors ligne.
  router.get('/preview-videos', async (req, res, next) => {
    const { eventId } = req.params;
    try {
      const token = forgePreviewToken(eventId);
      const upstream = await httpRequest(
        `${getBase(eventId)}/api/videos`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      let body = '';
      for await (const chunk of upstream) body += chunk;

      if (upstream.statusCode !== 200) {
        // La borne a répondu avec une erreur — le body peut être du HTML (nginx)
        // ou du JSON selon l'origine. On tente le parse JSON, sinon message générique.
        let json;
        try { json = JSON.parse(body); } catch { json = { error: `Borne d'essai : HTTP ${upstream.statusCode}` }; }
        return res.status(upstream.statusCode).json(json);
      }

      res.json(JSON.parse(body));
    } catch (err) {
      // ECONNREFUSED / ENOTFOUND → container preview down
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code)) {
        return res.status(503).json({ error: "Borne d'essai hors ligne" });
      }
      next(err);
    }
  });

  // ── GET /api/events/:eventId/preview-videos/:videoId/file ───────────────
  // Proxy Range-aware vers la route /videos/:id/file de la borne.
  // Propage le header Range entrant et reproduit fidèlement 200/206.
  // Accessible aussi via ?token= (invariant §11.2 pour les <video src>).
  router.get('/preview-videos/:videoId/file', async (req, res, next) => {
    const { eventId, videoId } = req.params;
    // Valider le format avant interpolation dans l'URL upstream
    if (/[/\\%.]/.test(videoId) || videoId.length > 64) {
      return res.status(400).json({ error: 'videoId invalide' });
    }
    try {
      const token = forgePreviewToken(eventId);
      const headers = { Authorization: `Bearer ${token}` };
      // Propager le Range du client (streaming, scrubbing Safari §11.3)
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }

      const upstream = await httpRequest(
        `${getBase(eventId)}/api/videos/${videoId}/file`,
        { headers }
      );

      // Recopier les headers pertinents
      const forward = [
        'content-type', 'content-length', 'content-range',
        'accept-ranges', 'last-modified',
      ];
      for (const h of forward) {
        const v = upstream.headers[h];
        if (v) res.setHeader(h, v);
      }

      res.status(upstream.statusCode);
      upstream.pipe(res);
    } catch (err) {
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code)) {
        return res.status(503).json({ error: "Borne d'essai hors ligne" });
      }
      next(err);
    }
  });

  // ── GET /api/events/:eventId/preview-storage ────────────────────────────
  // Retourne { used_bytes, quota_bytes } depuis /api/admin/health de la borne.
  router.get('/preview-storage', async (req, res, next) => {
    const { eventId } = req.params;
    try {
      const token = forgePreviewToken(eventId);
      const upstream = await httpRequest(
        `${getBase(eventId)}/api/admin/health`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      let body = '';
      for await (const chunk of upstream) body += chunk;
      let json;
      try { json = JSON.parse(body); } catch { json = {}; }
      if (upstream.statusCode !== 200) {
        return res.status(upstream.statusCode).json({ error: `Borne d'essai : HTTP ${upstream.statusCode}` });
      }
      res.json(json.storage ?? { used_bytes: 0, quota_bytes: 0 });
    } catch (err) {
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code)) {
        return res.status(503).json({ error: "Borne d'essai hors ligne" });
      }
      next(err);
    }
  });

  return router;
}

// ── Trigger pull preview (fire-and-forget) ────────────────────────────────────
// Appelé après chaque modif Hub (design, questions…) pour que la borne preview
// re-pull le bundle immédiatement. Échec silencieux si la borne est down.
export async function triggerPreviewPull(eventId, resolveBase) {
  const getBase = resolveBase ?? previewBackendBase;
  try {
    const token = forgePreviewToken(eventId);
    await httpRequest(`${getBase(eventId)}/api/sync/pull`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
    });
  } catch {
    // Borne hors ligne ou erreur réseau — ignoré silencieusement
  }
}
