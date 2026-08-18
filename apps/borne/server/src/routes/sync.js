import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { rmSync, existsSync, unlink } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getRegistry, getActiveEvent, updateEventStatus, getSetting, setSetting } from '../registry.js';
import { closeEventDb, getActiveEventDb } from '../eventDb.js';
import { getLastPull, pullMyEvent, pullMyEvents } from '../sync/pull.js';
import { pushEvent, pushConfig, getPushState } from '../sync/push.js';
import { hubFetchJson } from '../sync/hubClient.js';
import { getInitLog, logInit } from '../initLog.js';
import { startHeartbeat } from '../sync/heartbeat.js';

// admin_pin/tech_pin inclus : si un code est régénéré côté Hub, le technicien doit
// voir « config différente » sur place (sinon confusion — l'ancien code ne marche
// plus mais rien ne l'indique).
const META_HASH_KEYS = ['theme', 'idle_timeout', 'welcome_title', 'welcome_subtitle', 'name_prompt', 'consent_text', 'consent_details', 'thanks_text', 'admin_pin', 'tech_pin'];

function configHash(questions, meta) {
  const q = questions.map(({ text, max_duration, countdown, order_index, enabled }) =>
    ({ text, max_duration, countdown, order_index, enabled })
  );
  const m = Object.fromEntries(META_HASH_KEYS.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
  return createHash('sha256').update(JSON.stringify({ questions: q, meta: m })).digest('hex').slice(0, 8);
}

function isPreviewMode(cfg) {
  return !!(cfg.previewMode ?? config.previewMode) || !!(getActiveEvent()?.is_preview);
}

// hubUrl soumis par POST /sync/onboarding/pair vient d'une requête SANS AUTH —
// sans garde, une borne pourrait être pointée vers n'importe quelle machine du
// LAN/Internet (SSRF), dont le statut et le message d'erreur reviennent dans
// `pull.error`. https: exigé ; http: toléré uniquement vers localhost/127.0.0.1
// (dev). Ne s'applique qu'au hubUrl SOUMIS — le hubUrl déjà préconfiguré par
// `.env` (accès SSH, donc déjà de confiance, cf. §6bis) n'est jamais revalidé.
function isAllowedHubUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

function getLocalConfig(dataDir) {
  const active = getActiveEvent();
  if (!active) return null;
  try {
    const db = getActiveEventDb(dataDir, active);
    const questions = db.prepare(
      'SELECT id, text, max_duration, countdown, order_index, enabled FROM questions ORDER BY order_index, id'
    ).all();
    const metaRows = db.prepare('SELECT key, value FROM event_meta').all();
    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
    return { questions, meta, hash: configHash(questions, meta) };
  } catch {
    return null;
  }
}

export function makeSyncRouter(dataDir, cfg) {
  const router = Router();
  const auth = cfg.requireTech;

  // Rate-limiter pour la route de statut publique (borne preview Internet-facing,
  // sondée toutes les 4s par l'écran d'onboarding).
  const pairingStatusLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes, réessayez dans un moment.' },
    skip: () => cfg.skipRateLimits === true,
  });

  // ── GET /api/sync/pairing-status ────────────────────────────────────────────
  // AUCUNE auth (Phase C) : tant qu'aucun token n'est configuré, rien de sensible
  // n'existe encore sur la borne — l'écran d'onboarding (technicien sur place,
  // avant tout mot de passe) s'en sert pour montrer la progression de l'appairage.
  // Une fois appairée (hasToken=true), la route reste publique mais NE RÉPOND
  // PLUS que hasToken/hasActiveEvent — hubUrl (topologie interne du Hub) et logs
  // (ids d'événement, erreurs Hub) ne sont utiles qu'à l'écran d'onboarding et ne
  // doivent jamais fuiter sur une borne (a fortiori une preview, Internet-facing).
  router.get('/sync/pairing-status', pairingStatusLimiter, (req, res) => {
    // Identité PERSISTÉE/SEEDÉE uniquement — jamais `cfg.borneToken`/`config.borneToken`
    // seuls, qui peuvent porter le candidat d'un appairage RATÉ laissé en mémoire
    // (applyNewToken ne le restaure que s'il y avait un token précédent, cf.
    // routes/sync.js). Sans cette distinction, un premier essai avec un token mal
    // recopié ferait basculer hasToken à true — l'OnboardingScreen ne se
    // rafficherait plus au rechargement de page (sawUnpairedRef ne se latche
    // qu'une fois), alors qu'aucun PIN n'existe encore : console verrouillée
    // jusqu'à un redémarrage du conteneur. `getSetting('borne_token')` n'est
    // écrit qu'au boot (seed .env) ou après un pull réussi — jamais par un
    // essai raté.
    const hasToken = Boolean(getSetting('borne_token') || cfg.boxToken || config.boxToken);
    if (!hasToken) {
      const hubUrl = cfg.hubUrl || config.hubUrl || null;
      return res.json({ hasToken, hubUrl, hasActiveEvent: false, lastPull: null, logs: getInitLog() });
    }
    res.json({ hasToken, hasActiveEvent: Boolean(getActiveEvent()) });
  });

  // ── GET /api/sync/status ──────────────────────────────────────────────────────
  // Retourne connexion Hub, token masqué, config locale, état du push en cours.
  router.get('/sync/status', auth, (req, res) => {
    const hubUrl = cfg.hubUrl || config.hubUrl || null;
    // Phase B : une identité de borne physique prime sur le token d'événement
    // (boxToken) — les deux ne sont normalement jamais renseignés en même temps.
    const isBornePhysique = Boolean(cfg.borneToken || config.borneToken);
    const rawToken = isBornePhysique
      ? (cfg.borneToken || config.borneToken)
      : (cfg.boxToken || config.boxToken || null);

    // requiresLogin depuis event_meta (stocké au pull, §11.24)
    let requiresLogin = false;
    try {
      const active = getActiveEvent();
      if (active && active.is_preview) {
        const db = getActiveEventDb(dataDir, active);
        const meta = db.prepare("SELECT value FROM event_meta WHERE key = 'requires_login'").get();
        requiresLogin = meta?.value === 'true';
      }
    } catch { /* aucun événement actif */ }

    res.json({
      online: !!hubUrl,
      hubUrl,
      token: rawToken ? `${rawToken.slice(0, 8)}…` : null,
      // 'borne' = identité machine persistante (Phase B) ; 'event' = token
      // d'événement (preview, ou legacy token=événement) — l'onglet Identité
      // s'en sert pour adapter son libellé.
      tokenKind: isBornePhysique ? 'borne' : 'event',
      isPreview: isPreviewMode(cfg),
      requiresLogin,
      lastPull: getLastPull(),
      localConfig: getLocalConfig(dataDir),
      push: getPushState(),
    });
  });

  // ── GET /api/sync/hub-config ──────────────────────────────────────────────────
  // Récupère la config actuelle du Hub (bundle) pour comparaison avec le local.
  router.get('/sync/hub-config', auth, async (req, res, next) => {
    try {
      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });
      const bundle = await hubFetchJson(`/api/sync/events/${active.id}/bundle`);
      const questions = bundle.questions;
      const meta = bundle.event.meta ?? {};
      res.json({ questions, meta, hash: configHash(questions, meta) });
    } catch (err) {
      next(err);
    }
  });

  // Applique un nouveau token (détection borne physique vs preview/événement,
  // persistance, pull immédiat) — factorisé entre POST /sync/token (rotation,
  // authentifiée) et POST /sync/onboarding/pair (appairage initial, sans auth).
  //
  // Détection du TYPE de token : on ne peut pas se fier à `config.borneToken`
  // déjà renseigné — ça exclurait l'appairage INITIAL d'une borne physique
  // (aucun BORNE_TOKEN au premier démarrage). On interroge directement le Hub
  // sur la route réservée aux bornes physiques : 400 = le Hub a résolu le
  // token comme un token d'événement (box_tokens) → bascule sur l'ancien
  // chemin ; tout le reste (200, ou une erreur qui n'est pas ce 400 précis) =
  // token borne, persisté (survit à un redémarrage du container — à la
  // différence du boxToken preview, jamais persisté puisque le provisioner le
  // réinjecte via l'env à chaque (re)création du container).
  //
  // Retourne le résultat du pull (pas juste { ok:true }) : l'appelant HTTP
  // (onboarding notamment) en a besoin pour confirmer concrètement au
  // technicien ce qui s'est passé, plutôt qu'un succès de façade qui masquerait
  // un Hub injoignable ou aucun événement assigné.
  //
  // Persistance et mutation en mémoire sont volontairement DÉCOUPLÉES : le
  // nouveau token doit être en mémoire AVANT l'appel Hub (hubFetchJson lit
  // cfg/config), mais n'est écrit dans borne_settings (survit à un redémarrage)
  // qu'une fois le pull confirmé réussi. Sur échec, l'un et l'autre sont
  // restaurés à leur valeur précédente — SANS CONDITION, y compris quand cette
  // valeur précédente est vide (premier appairage) : ni le verrou de
  // re-appairage (borne_settings.paired_at + présence de local_events,
  // POST /sync/onboarding/pair) ni `hasToken` (GET /sync/pairing-status) ne
  // lisent plus ce candidat en mémoire — l'un comme l'autre lisent l'identité
  // PERSISTÉE. Restaurer sans condition évite donc symétriquement les deux
  // pièges déjà rencontrés : perdre un token FONCTIONNEL sur une rotation ratée
  // (branche borne), et laisser un candidat FAUTIF trainer en mémoire au point
  // de fausser `hasToken` (branche événement, qui lit encore `cfg.boxToken`/
  // `config.boxToken` en direct — jamais persisté par design, cf. plus bas).
  async function applyNewToken(trimmed) {
    const previousBorneToken = config.borneToken;
    const previousBoxToken = config.boxToken;
    config.borneToken = trimmed;
    cfg.borneToken = trimmed;

    let isBorneToken = true;
    try {
      await hubFetchJson('/api/sync/borne/events');
    } catch (err) {
      if (err.status === 400) isBorneToken = false;
      // autres statuts (401 token invalide, réseau…) : ne renseignent pas
      // sur le TYPE, on suppose borne physique et on laisse le pull échouer
      // normalement ci-dessous (l'utilisateur verra l'erreur au prochain sync).
    }

    let pull;
    if (isBorneToken) {
      pull = await pullMyEvents(dataDir)
        .then(({ pulled }) => ({ ok: true, pulled: pulled > 0 }))
        .catch((err) => ({ ok: false, error: err.message }));
      if (pull.ok) {
        setSetting('borne_token', trimmed);
        startHeartbeat(dataDir); // no-op si déjà démarré (borne appairée dès le boot)
      } else {
        config.borneToken = previousBorneToken;
        cfg.borneToken = previousBorneToken;
      }
    } else {
      config.borneToken = previousBorneToken;
      cfg.borneToken = previousBorneToken;

      // Un token d'événement (box_tokens) est réservé aux bornes d'essai (§1
      // PROJET.md) — jamais une machine physique. Sur une borne réelle,
      // l'accepter créerait exactement l'asymétrie qui a cassé le verrou
      // d'appairage : boxToken n'est JAMAIS persisté (à la différence de
      // borne_token, cf. commentaire plus haut), donc la borne semblerait
      // appairée le temps du process (hasToken:true, un PIN fonctionnerait
      // même) mais redeviendrait un cul-de-sac au premier redémarrage —
      // aucun PIN, aucune session, et le verrou de re-appairage déjà refermé
      // si un pull avait entretemps réussi (§11.30). Refuser clairement ici
      // plutôt que de réintroduire cette ambiguïté : le technicien a collé le
      // mauvais type de token, le formulaire doit le dire, pas y donner suite
      // en silence. Sans effet sur la preview elle-même — cette branche n'y
      // est atteignable QUE via POST /sync/token (rotation authentifiée, où
      // un box token reste légitime) ; POST /sync/onboarding/pair est déjà
      // refusée en mode preview (404, plus haut) donc n'y arrive jamais.
      if (!isPreviewMode(cfg)) {
        pull = {
          ok: false,
          error: "Ce token est un token d'événement (borne d'essai), pas un token de borne — une borne physique a besoin d'un token de borne (Hub → onglet Bornes).",
        };
      } else {
        config.boxToken = trimmed;
        cfg.boxToken = trimmed;
        pull = await pullMyEvent(dataDir)
          .then((n) => ({ ok: true, pulled: n > 0 }))
          .catch((err) => ({ ok: false, error: err.message }));
        if (!pull.ok) {
          config.boxToken = previousBoxToken;
          cfg.boxToken = previousBoxToken;
        }
      }
    }
    return { isBorneToken, pull, hasActiveEvent: Boolean(getActiveEvent()) };
  }

  // ── POST /api/sync/onboarding/pair ───────────────────────────────────────────
  // AUCUNE auth (Phase C) : appairage INITIAL depuis l'écran d'onboarding — le
  // même raisonnement que pairing-status s'applique (rien de sensible n'existe
  // encore tant que hasToken=false).
  //
  // Se referme dès qu'un token a été VALIDÉ — un pull a réussi avec ce token,
  // preuve d'un round-trip Hub authentifié abouti — pas dès qu'un token a
  // simplement été SAISI : un token invalide/mal recopié ne doit pas
  // verrouiller la borne sur un cul-de-sac (401 permanent, aucun PIN, plus de
  // TECH_PASSWORD depuis son retrait — cf. §11.30 PROJET.md) — tant qu'aucun
  // pull n'a jamais abouti, on autorise à corriger et resoumettre depuis ce
  // même écran.
  //
  // Le verrou est PERSISTÉ (borne_settings.paired_at, posé au premier pull
  // réussi — voir pull.js), pas juste getLastPull() : ce dernier est un
  // singleton en mémoire, remis à zéro à chaque redémarrage du process. Sans
  // verrou persisté, une borne déjà appairée mais offline (cas nominal pendant
  // l'événement : Wi-Fi local sans sortie Internet, cf. §1 PROJET.md) qui
  // redémarre — coupure de courant, mise à jour — rouvrirait cette route sans
  // auth sur une machine qui porte déjà token, événement et vidéos d'invités.
  //
  // Doublé de deux autres signaux de fait :
  // - au moins une ligne `local_events` — couvre une borne mise à niveau depuis
  //   une version antérieure à `paired_at` (colonne nouvelle) : ses événements
  //   pullés avant cette migration en sont la preuve tout aussi valable, sans
  //   attendre un pull de plus pour fermer le verrou ;
  // - `borne_settings.borne_token` déjà persisté — cas d'une borne seedée par
  //   BORNE_TOKEN en .env (resolveBorneIdentity() le persiste au boot, SANS
  //   round-trip Hub, cf. §6bis) qui n'a encore jamais réussi de pull : sans ce
  //   signal, un tiers sur le LAN pourrait réappairer une machine que
  //   `pairing-status` annonce pourtant déjà `hasToken:true` (donc SANS
  //   formulaire proposé côté UI). Ce chemin suppose déjà un accès SSH/.env —
  //   la correction d'un token mal seedé se fait par ce même accès, pas par ce
  //   formulaire public.
  router.post('/sync/onboarding/pair', pairingStatusLimiter, async (req, res, next) => {
    try {
      if (isPreviewMode(cfg)) {
        return res.status(404).json({ error: 'Non disponible en mode démo (borne d\'essai)' });
      }

      const hasExistingEvent = getRegistry().prepare('SELECT 1 FROM local_events LIMIT 1').get() !== undefined;
      const alreadyPaired = getSetting('paired_at') !== null || hasExistingEvent || getSetting('borne_token') !== null;
      if (alreadyPaired) {
        return res.status(403).json({ error: 'Borne déjà appairée' });
      }

      const { token, hubUrl } = req.body ?? {};
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return res.status(400).json({ error: 'token requis' });
      }
      const submittedHubUrl = typeof hubUrl === 'string' ? hubUrl.trim() : '';
      if (submittedHubUrl && !isAllowedHubUrl(submittedHubUrl)) {
        return res.status(400).json({ error: 'hubUrl invalide — HTTPS requis (HTTP toléré uniquement en local, vers localhost)' });
      }
      const effectiveHubUrl = submittedHubUrl || cfg.hubUrl || config.hubUrl;
      if (!effectiveHubUrl) {
        return res.status(400).json({ error: 'hubUrl requis (aucun Hub préconfiguré)' });
      }
      // En mémoire tout de suite (nécessaire à hubFetchJson dans applyNewToken),
      // mais persisté SEULEMENT après un pull réussi (cf. borneToken/boxToken
      // dans applyNewToken, même raisonnement) — sinon une requête non
      // authentifiée réécrit durablement l'URL du Hub avant toute validation.
      const previousHubUrl = config.hubUrl;
      config.hubUrl = effectiveHubUrl;
      cfg.hubUrl = effectiveHubUrl;

      logInit('info', `Appairage — token reçu depuis la console, Hub ${effectiveHubUrl}`);
      const { isBorneToken, pull, hasActiveEvent } = await applyNewToken(token.trim());
      if (pull.ok) {
        setSetting('hub_url', effectiveHubUrl);
      } else {
        config.hubUrl = previousHubUrl;
        cfg.hubUrl = previousHubUrl;
      }
      logInit(
        pull.ok ? 'info' : 'error',
        pull.ok
          ? `Appairage — token ${isBorneToken ? 'de borne' : 'd\'événement'} validé, pull ${pull.pulled ? 'réussi' : 'sans événement à charger'}`
          : `Appairage — token ${isBorneToken ? 'de borne' : 'd\'événement'} validé, mais le pull a échoué — ${pull.error}`,
      );

      // pull.ok = un round-trip Hub authentifié a abouti AVEC ce token précis —
      // c'est la preuve d'autorisation elle-même (le Hub a reconnu le token),
      // pas juste "une chaîne a été saisie". Pas besoin d'un second secret
      // (TECH_PASSWORD, retiré) pour ouvrir une session tech_borne à la suite
      // du même geste : l'émettre ici évite un aller-retour de connexion
      // séparé pour quelqu'un qui vient de prouver qu'il détient le token.
      const sessionToken = pull.ok ? jwt.sign({ roles: ['tech_borne'] }, config.jwtSecret, { expiresIn: '24h' }) : null;

      // Réponse volontairement détaillée (pas juste { ok:true }) : l'écran
      // d'onboarding s'en sert pour confirmer concrètement au technicien ce qui
      // s'est passé — token accepté ne veut pas dire Hub joignable, ni pull
      // réussi, ni événement assigné.
      res.json({ ok: true, tokenKind: isBorneToken ? 'borne' : 'event', pull, hasActiveEvent, token: sessionToken });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/token ──────────────────────────────────────────────────────
  // Change le token à chaud (sans redémarrer). Déclenche un pull immédiat.
  // Réservée à une borne déjà appairée (rotation) — voir applyNewToken() pour
  // l'appairage initial sans auth.
  router.post('/sync/token', auth, async (req, res, next) => {
    try {
      const { token } = req.body ?? {};
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return res.status(400).json({ error: 'token requis' });
      }
      await applyNewToken(token.trim());
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/pull ───────────────────────────────────────────────────────
  // Pull manuel : attend la fin et retourne le résultat.
  router.post('/sync/pull', auth, async (req, res, next) => {
    try {
      const pulled = await pullMyEvent(dataDir);
      res.json({ ok: true, pulled: pulled > 0, localConfig: getLocalConfig(dataDir) });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/push-config ───────────────────────────────────────────────
  // Pousse questions + event_meta de l'événement actif vers le Hub (overwrite).
  // Réservé à la borne réelle : interdit en mode preview (config Hub = source de vérité).
  router.post('/sync/push-config', auth, async (req, res, next) => {
    try {
      if (isPreviewMode(cfg)) {
        return res.status(403).json({ error: 'Push config interdit en mode démo (borne d\'essai)' });
      }
      if (!config.hubUrl && !cfg.hubUrl) {
        return res.status(409).json({ error: 'Aucun Hub configuré — rien à pousser' });
      }
      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });
      const result = await pushConfig(active.id, dataDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/push/:eventId ─────────────────────────────────────────────
  // Lance le push en tâche de fond. 409 si event pas closed, déjà en cours, ou mode démo.
  router.post('/sync/push/:eventId', auth, (req, res, next) => {
    const { eventId } = req.params;
    const db = getRegistry();
    const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);

    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    if (isPreviewMode(cfg)) {
      return res.status(409).json({ error: 'Push interdit en mode démo (borne d\'essai)' });
    }

    if (event.status !== 'closed') {
      return res.status(409).json({ error: 'Clôturez l\'événement avant le push' });
    }

    const state = getPushState();
    if (state.running) {
      return res.status(409).json({ error: 'Un push est déjà en cours' });
    }

    // Lancement en tâche de fond — la progression se lit via GET /sync/status
    pushEvent(eventId, dataDir).catch(() => {});

    res.json({ ok: true });
  });

  // ── POST /api/sync/reset-preview ─────────────────────────────────────────────
  // Purge sessions + vidéos de l'événement actif sans toucher aux questions.
  // Refusé hors mode démo (§11.21 / 6D.3).
  router.post('/sync/reset-preview', auth, (req, res, next) => {
    try {
      if (!isPreviewMode(cfg)) {
        return res.status(403).json({ error: 'Disponible uniquement en mode démo (borne d\'essai)' });
      }

      const active = getActiveEvent();
      if (!active) return res.status(404).json({ error: 'Aucun événement actif' });

      const db = getActiveEventDb(dataDir, active);
      const videos = db.prepare('SELECT filename FROM videos').all();

      db.transaction(() => {
        db.prepare('DELETE FROM videos').run();
        db.prepare('DELETE FROM sessions').run();
      })();

      for (const v of videos) {
        unlink(join(dataDir, 'events', active.id, 'videos', v.filename), () => {});
      }

      res.json({ ok: true, deleted: videos.length });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/sync/purge/:eventId ────────────────────────────────────────────
  // Supprime les fichiers locaux après push. Exige status='pushed' et { confirm: name }.
  router.post('/sync/purge/:eventId', auth, (req, res, next) => {
    try {
      const { eventId } = req.params;
      const { confirm } = req.body ?? {};
      const db = getRegistry();
      const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);

      if (!event) return res.status(404).json({ error: 'Événement introuvable' });

      if (event.status !== 'pushed') {
        return res.status(409).json({ error: 'Seul un événement poussé peut être purgé' });
      }

      if (!confirm || confirm !== event.name) {
        return res.status(400).json({ error: 'Confirmation par le nom de l\'événement requise' });
      }

      // §11.11 : fermer le handle SQLite de l'event avant tout rm -rf
      // (l'event purgé peut encore être l'actif si close/push n'ont pas remis active=0)
      closeEventDb();

      // Supprime le dossier physique (vidéos, db.sqlite, etc.)
      const eventDir = join(dataDir, 'events', eventId);
      if (existsSync(eventDir)) {
        rmSync(eventDir, { recursive: true, force: true });
      }

      // Nettoie push_state + désactive l'event (ne doit plus être servi au kiosque)
      db.prepare('DELETE FROM push_state WHERE event_id = ?').run(eventId);
      db.prepare('UPDATE local_events SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventId);

      // Passe en 'purged'
      updateEventStatus(eventId, 'purged');

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
