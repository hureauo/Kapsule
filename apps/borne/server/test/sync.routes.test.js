import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { createApp } from '../src/index.js';
import { closeRegistry, getRegistry, insertEvent, updateEventStatus, getSetting, setSetting } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { config } from '../src/config.js';
import { resetLastPull } from '../src/sync/pull.js';
import { seedAuthUsers, loginAdmin, loginTech, clearSeedEvent } from './helpers.js';

const TEST_CFG = {
  jwtSecret: 'secret-test',
  dataDir: '',
  hubUrl: 'https://hub.test',
  boxToken: 'tok',
  skipRateLimits: true,
};

// Plus de fallback TECH_PASSWORD (§11.30) : quand un test a besoin d'un token
// tech_borne SANS événement/PIN seedé (ex. previewMode sans event actif), on
// signe directement un JWT plutôt que de passer par POST /api/admin/login.
function signTechToken() {
  return jwt.sign({ roles: ['tech_borne'] }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-sync-routes-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  await seedAuthUsers(dir);
  // Les routes sync requièrent requireTech → token tech_borne
  const token = await loginTech(app, request);
  // Token admin_borne pour les tests d'accès refusé (§11.19)
  const clientToken = await loginAdmin(app, request);
  clearSeedEvent(); // retire ev-seed pour ne pas polluer les tests "aucun event actif"
  return { dir, app, token, clientToken };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Crée un event en statut closed avec un db.sqlite valide.
 */
function makeClosedEvent(dir, eventId) {
  const eventDir = join(dir, 'events', eventId);
  mkdirSync(join(eventDir, 'videos'), { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  edb.close();
  insertEvent({ id: eventId, name: 'Mon Event', origin: 'hub', status: 'loaded' });
  updateEventStatus(eventId, 'live');
  updateEventStatus(eventId, 'closed');
}

let savedFetch;
function mockFetchSuccess() {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: [] }) };
    if (url.endsWith('/db')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/assigned')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}
function restoreFetch() {
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
}

// ── GET /api/sync/status ─────────────────────────────────────────────────────

// ── GET /api/sync/pairing-status ─────────────────────────────────────────────
// AUCUNE auth (Phase C) : c'est tout l'intérêt — l'écran d'onboarding pré-
// appairage doit pouvoir l'interroger sans mot de passe.

describe('GET /api/sync/pairing-status', () => {
  let dir, app;

  beforeEach(async () => {
    ({ dir, app } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('répond 200 sans aucune authentification', async () => {
    const res = await request(app).get('/api/sync/pairing-status');
    assert.equal(res.status, 200);
  });

  it('une fois appairée (hasToken=true), ne renvoie que hasToken/hasActiveEvent — ni hubUrl ni logs', async () => {
    const res = await request(app).get('/api/sync/pairing-status');
    assert.deepEqual(Object.keys(res.body).sort(), ['hasActiveEvent', 'hasToken']);
    assert.equal(JSON.stringify(res.body).includes(TEST_CFG.boxToken), false);
  });

  it('hasToken=true quand boxToken est configuré (setup() en fournit un)', async () => {
    const res = await request(app).get('/api/sync/pairing-status');
    assert.equal(res.body.hasToken, true);
  });
});

describe('GET /api/sync/pairing-status — sans aucun token configuré', () => {
  it('hasToken=false, hasActiveEvent=false, expose hubUrl/lastPull/logs (onboarding)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-pairing-'));
    const app = createApp(dir, { ...config, dataDir: dir, hubUrl: '', boxToken: '', borneToken: '', skipRateLimits: true });
    const res = await request(app).get('/api/sync/pairing-status');
    assert.equal(res.status, 200);
    assert.equal(res.body.hasToken, false);
    assert.equal(res.body.hasActiveEvent, false);
    assert.ok('hubUrl' in res.body);
    assert.ok('lastPull' in res.body);
    assert.ok(Array.isArray(res.body.logs));
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── POST /api/sync/onboarding/pair ───────────────────────────────────────────
// AUCUNE auth (Phase C) : appairage initial depuis l'écran d'onboarding. Se
// referme dès qu'un token a été VALIDÉ — verrou PERSISTÉ (borne_settings.paired_at
// OU au moins une ligne local_events, cf. §11.30), pas getLastPull() (singleton
// en mémoire, insuffisant) — pas dès qu'un token a simplement été saisi.

describe('POST /api/sync/onboarding/pair', () => {
  const origBorneToken = config.borneToken;
  const origBoxToken = config.boxToken;
  const origHubUrl = config.hubUrl;

  beforeEach(() => {
    // Repart d'un singleton pristine indépendamment de ce qu'un test précédent
    // (ex. POST /sync/token, plus bas dans ce fichier) a pu y laisser.
    config.borneToken = '';
    config.boxToken = '';
    config.hubUrl = '';
    // getLastPull() est un singleton module-level (pull.js) sans lien avec
    // dataDir/app — un pull réussi dans une AUTRE suite (ou un test précédent
    // de celle-ci) le laisserait non-nul ici, faussant le verrou de
    // re-appairage testé plus bas.
    resetLastPull();
  });

  afterEach(() => {
    config.borneToken = origBorneToken;
    config.boxToken = origBoxToken;
    config.hubUrl = origHubUrl;
    restoreFetch();
  });

  function makeUnpairedApp(dir) {
    return createApp(dir, { ...config, dataDir: dir, hubUrl: '', boxToken: '', borneToken: '', skipRateLimits: true });
  }

  it('retourne 400 si token absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);
    const res = await request(app).post('/api/sync/onboarding/pair').send({});
    assert.equal(res.status, 400);
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retourne 400 si hubUrl absent et aucun Hub préconfiguré', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);
    const res = await request(app).post('/api/sync/onboarding/pair').send({ token: 'abc' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /hubUrl/);
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // hubUrl vient d'une requête SANS AUTH — sans validation, une borne pourrait
  // être pointée vers n'importe quelle machine du LAN/Internet (SSRF), avec le
  // statut/message d'erreur distant réfléchi dans pull.error.
  it('retourne 400 sur un hubUrl non-https (SSRF) — même vers une IP interne plausible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);
    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'abc', hubUrl: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /hubUrl/i);
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepte http:// vers localhost (dev)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'abc', hubUrl: 'http://localhost:3001' });
    assert.notEqual(res.status, 400);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appaire un token de borne (200 sur /sync/borne/events) et bascule hasToken à true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'borne-token-abc', hubUrl: 'https://hub.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Réponse détaillée : pas juste { ok:true } — l'onboarding doit pouvoir
    // confirmer concrètement le résultat du pull, pas juste "token accepté".
    assert.equal(res.body.tokenKind, 'borne');
    assert.equal(res.body.pull.ok, true);
    assert.equal('hasActiveEvent' in res.body, true);

    // pull.ok = preuve d'autorisation (le Hub a validé CE token) — une session
    // tech_borne est émise directement, sans TECH_PASSWORD (retiré, §11.30).
    // Signée avec config.jwtSecret (singleton LIVE — makeUnpairedApp() passe
    // une snapshot {...config} à createApp, donc pas nécessairement égal à
    // TEST_CFG.jwtSecret ici ; seule la production garantit cfg===config).
    assert.ok(res.body.token);
    const payload = jwt.verify(res.body.token, config.jwtSecret);
    assert.deepEqual(payload.roles, ['tech_borne']);

    const statusRes = await request(app).get('/api/sync/pairing-status');
    assert.equal(statusRes.body.hasToken, true);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // Interopérabilité client/serveur : borne-web et borne-server sont TOUJOURS
  // déployés ensemble (même commit, même `docker compose … --build`), donc pas
  // de scénario de versions divergentes au sens strict — mais le contrat HTTP
  // doit rester tolérant à un client qui n'envoie pas tous les champs (ex. un
  // formulaire où le champ Hub est masqué parce que déjà préconfiguré). Le
  // serveur ne doit JAMAIS exiger du client qu'il lui redonne une information
  // qu'il connaît déjà lui-même.
  it('accepte un client qui n\'envoie pas hubUrl si le Hub est déjà préconfiguré côté serveur (.env)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = createApp(dir, { ...config, dataDir: dir, hubUrl: 'https://hub-preconfigured.test', boxToken: '', borneToken: '', skipRateLimits: true });

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'borne-token-minimal' }); // pas de hubUrl dans le body
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('token accepté mais pull échoué (Hub joignable, /borne/events répond, /sync/borne/events échoue au pull) — réponse le reflète', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // isBorneToken=true (200 ici) mais pullMyEvents() échoue ensuite sur ce même endpoint
      if (url.includes('/sync/borne/events')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'borne-token-fail', hubUrl: 'https://hub.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true); // la requête elle-même a été traitée — ne dit rien du pull
    assert.equal(res.body.pull.ok, false);
    assert.ok(res.body.pull.error);
    // Pas de session ouverte sans preuve d'un round-trip Hub abouti.
    assert.equal(res.body.token, null);

    // Rien n'est persisté sur un pull échoué (le candidat reste en mémoire pour
    // ce process, retentable, mais pairing-status calcule hasToken depuis
    // l'identité PERSISTÉE — jamais depuis le candidat d'un essai raté, sinon
    // sawUnpairedRef ne se latcherait plus au rechargement de la page alors
    // qu'aucun PIN n'existe encore).
    const statusRes = await request(app).get('/api/sync/pairing-status');
    assert.equal(statusRes.body.hasToken, false);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('un pull échoué ne verrouille pas l\'appairage — un second essai (token corrigé) est accepté', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    // Distingue les deux essais par le token envoyé (X-Box-Token), pas par un
    // compteur d'appels : applyNewToken() appelle déjà /sync/borne/events DEUX
    // fois par tentative (détection du type + pull effectif), un compteur
    // brut confondrait les deux appels du 1er essai avec le 2e essai.
    globalThis.fetch = async (url, options) => {
      if (url.includes('/sync/borne/events')) {
        const tok = options?.headers?.['X-Box-Token'];
        return tok === 'token-fautif'
          ? { ok: false, status: 401, json: async () => ({ error: 'Token borne invalide' }) }
          : { ok: true, status: 200, json: async () => ({ events: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const first = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'token-fautif', hubUrl: 'https://hub.test' });
    assert.equal(first.status, 200);
    assert.equal(first.body.pull.ok, false);
    assert.equal(first.body.token, null);

    // Rien n'a jamais réussi (getLastPull() toujours nul) : pas de 403 ici.
    const second = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'token-corrige', hubUrl: 'https://hub.test' });
    assert.equal(second.status, 200);
    assert.equal(second.body.pull.ok, true);
    assert.ok(second.body.token);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // Un token d'événement (box_tokens) est réservé aux bornes d'essai (§1
  // PROJET.md) — jamais persisté (à la différence de borne_token), donc
  // l'accepter sur une borne réelle créait un cul-de-sac au premier
  // redémarrage (hasToken redevenu false, mais la route déjà verrouillée si un
  // pull avait entretemps réussi). Refusé clairement maintenant, pour une
  // borne non-preview — `makeUnpairedApp` en est une.
  it('refuse un token d\'événement sur une borne réelle (réservé aux bornes d\'essai)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: false, status: 400, json: async () => ({ error: 'not a borne token' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'event-token-abc', hubUrl: 'https://hub.test' });
    assert.equal(res.status, 200); // la requête est traitée — c'est le pull qui est refusé
    assert.equal(res.body.tokenKind, 'event');
    assert.equal(res.body.pull.ok, false);
    assert.match(res.body.pull.error, /événement|borne d'essai/i);
    assert.equal(res.body.token, null);

    // Ni persisté, ni gardé en mémoire — hasToken reste false.
    const statusRes = await request(app).get('/api/sync/pairing-status');
    assert.equal(statusRes.body.hasToken, false);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retourne 403 sur un second appel une fois appairée', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await request(app).post('/api/sync/onboarding/pair').send({ token: 'first', hubUrl: 'https://hub.test' });
    const res = await request(app).post('/api/sync/onboarding/pair').send({ token: 'second', hubUrl: 'https://hub.test' });
    assert.equal(res.status, 403);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // Régression du verrou persisté (borne_settings.paired_at) : avant le fix,
  // le verrou de re-appairage reposait sur getLastPull(), un singleton EN
  // MÉMOIRE remis à zéro à chaque redémarrage du process — donc un simple
  // restart (coupure de courant, mise à jour) rouvrait cette route sans auth
  // sur une borne déjà appairée. resetLastPull() simule exactement ce
  // redémarrage : le verrou doit rester fermé malgré lui.
  it('reste verrouillée (403) même après un redémarrage du process (paired_at survit à resetLastPull)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const first = await request(app).post('/api/sync/onboarding/pair').send({ token: 'first', hubUrl: 'https://hub.test' });
    assert.equal(first.status, 200);

    resetLastPull(); // simule le redémarrage du process : _lastPull redevient null

    const second = await request(app).post('/api/sync/onboarding/pair').send({ token: 'attacker-token', hubUrl: 'https://attacker.test' });
    assert.equal(second.status, 403);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // Régression : une borne mise à niveau depuis une version antérieure à
  // `paired_at` (colonne nouvelle) porte déjà des `local_events` — pullés par
  // un vrai appairage passé — sans que `paired_at` ait jamais été posée. Le
  // verrou doit se fermer sur CE signal aussi, pas seulement sur `paired_at`,
  // sinon la route rouvre sans auth le temps d'un pull de plus.
  it('reste verrouillée (403) si des local_events existent déjà, même sans paired_at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    insertEvent({ id: 'ev-deja-pulle', name: 'Événement déjà présent', origin: 'hub', status: 'loaded' });
    assert.equal(getSetting('paired_at'), null); // le signal historique, pas le nouveau

    const res = await request(app).post('/api/sync/onboarding/pair').send({ token: 'attacker-token', hubUrl: 'https://attacker.test' });
    assert.equal(res.status, 403);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  // Régression : une borne seedée par BORNE_TOKEN en .env (resolveBorneIdentity()
  // persiste borne_token au boot, SANS round-trip Hub, §6bis) mais qui n'a
  // jamais réussi de pull n'a ni paired_at ni local_events — sans ce 3e signal,
  // un tiers sur le LAN pourrait poster sur cette route non authentifiée alors
  // même que pairing-status annonce déjà hasToken:true (donc sans formulaire
  // proposé côté UI, impasse pour l'opérateur légitime).
  it('reste verrouillée (403) si borne_token est déjà persisté, même sans paired_at ni local_events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    setSetting('borne_token', 'seedé-depuis-env');
    assert.equal(getSetting('paired_at'), null);
    assert.equal(getRegistry().prepare('SELECT 1 FROM local_events LIMIT 1').get(), undefined);

    const res = await request(app).post('/api/sync/onboarding/pair').send({ token: 'attacker-token', hubUrl: 'https://attacker.test' });
    assert.equal(res.status, 403);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuse (404) en mode preview — surface Internet-facing, pas de formulaire d\'appairage public', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = createApp(dir, { ...config, dataDir: dir, hubUrl: '', boxToken: '', borneToken: '', previewMode: true, skipRateLimits: true });

    const res = await request(app).post('/api/sync/onboarding/pair').send({ token: 'abc', hubUrl: 'https://hub.test' });
    assert.equal(res.status, 404);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ne persiste pas hub_url si le pull échoue (persistance différée à un round-trip Hub abouti)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-onboard-'));
    const app = makeUnpairedApp(dir);

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/onboarding/pair')
      .send({ token: 'borne-token-fail', hubUrl: 'https://hub-jamais-enregistre.test' });
    assert.equal(res.body.pull.ok, false);
    assert.equal(getSetting('hub_url'), null);

    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('GET /api/sync/status', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne les champs attendus', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.ok('online' in res.body);
    assert.ok('hubUrl' in res.body);
    assert.ok('token' in res.body);
    assert.ok('isPreview' in res.body);
    assert.ok('lastPull' in res.body);
    assert.ok('localConfig' in res.body);
    assert.ok('push' in res.body);
    assert.ok('running' in res.body.push);
    assert.ok('total' in res.body.push);
    assert.ok('done' in res.body.push);
    assert.ok('currentFile' in res.body.push);
  });

  it('token masqué (8 chars + …)', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.body.token, 'tok…');
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/sync/status');
    assert.equal(res.status, 401);
  });

  it('online=true si hubUrl configuré', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.body.online, true);
    assert.equal(res.body.hubUrl, 'https://hub.test');
  });
});

// ── POST /api/sync/pull ──────────────────────────────────────────────────────

describe('POST /api/sync/pull', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    // Mock /sync/event → 404 gracieux (pas d'event pullable)
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/event') && !url.includes('/bundle') && !url.includes('/status')) {
        return { ok: false, status: 404, json: async () => ({ error: 'Aucun' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne { ok: true, pulled } après le pull', async () => {
    const res = await request(app)
      .post('/api/sync/pull')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok('pulled' in res.body);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/sync/pull');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sync/token ──────────────────────────────────────────────────────

describe('POST /api/sync/token', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/event') && !url.includes('/bundle')) {
        return { ok: false, status: 404, json: async () => ({ error: 'Aucun' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('accepte un nouveau token et retourne { ok: true }', async () => {
    const res = await request(app)
      .post('/api/sync/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'nouveau-token-xyz' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 400 si token absent', async () => {
    const res = await request(app)
      .post('/api/sync/token')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it('retourne 401 sans token auth', async () => {
    const res = await request(app)
      .post('/api/sync/token')
      .send({ token: 'abc' });
    assert.equal(res.status, 401);
  });

  // Régression : avant le fix, applyNewToken() ne restaurait config.borneToken
  // sur échec que dans la branche "token d'événement" — une rotation ratée en
  // branche borne (faute de frappe, token expiré) écrasait un appairage
  // fonctionnel en mémoire, récupérable seulement en SSH sur une machine qui
  // n'en a pas toujours (Raspberry sur le Wi-Fi de l'événement).
  it('restaure le token de borne précédent en mémoire si la rotation échoue', async () => {
    const origBorneToken = config.borneToken;
    config.borneToken = 'borne-token-fonctionnel';
    restoreFetch();
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(app)
      .post('/api/sync/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'token-fautif' });
    // /sync/token répond toujours { ok: true } (ne reflète pas l'échec du pull,
    // cf. commentaire de la route) — c'est l'état en mémoire qui compte ici.
    assert.equal(res.status, 200);
    assert.equal(config.borneToken, 'borne-token-fonctionnel');

    config.borneToken = origBorneToken;
  });

  // Le refus des tokens d'événement (ci-dessus, POST /sync/onboarding/pair)
  // est scopé à `!isPreviewMode(cfg)` : une preview a un usage légitime de
  // POST /sync/token pour faire tourner son propre box token (le provisioner
  // le réinjecte normalement via l'env à chaque recréation, mais rien
  // n'empêche une rotation manuelle). Ce test verrouille que ce chemin reste
  // ouvert — sinon le refus ci-dessus serait un excès de zèle qui casserait un
  // usage réel.
  it('accepte toujours un token d\'événement en mode preview (rotation légitime du box token)', async () => {
    const origBoxToken = config.boxToken;
    const dir = mkdtempSync(join(tmpdir(), 'borne-preview-token-'));
    const previewApp = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true, borneToken: '' });
    const previewToken = signTechToken();

    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/sync/borne/events')) return { ok: false, status: 400, json: async () => ({ error: 'not a borne token' }) };
      if (url.includes('/sync/event') && !url.includes('/bundle')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await request(previewApp)
      .post('/api/sync/token')
      .set('Authorization', `Bearer ${previewToken}`)
      .send({ token: 'nouveau-box-token' });
    assert.equal(res.status, 200);
    assert.equal(config.boxToken, 'nouveau-box-token');

    config.boxToken = origBoxToken;
    restoreFetch();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── POST /api/sync/push/:eventId ─────────────────────────────────────────────

describe('POST /api/sync/push/:eventId', () => {
  let dir, app, token, clientToken;

  beforeEach(async () => {
    ({ dir, app, token, clientToken } = await setup());
    mockFetchSuccess();
  });
  afterEach(async () => {
    restoreFetch();
    // Attendre que le push en tâche de fond termine pour éviter les fuites
    await new Promise(r => setTimeout(r, 100));
    teardown(dir);
  });

  it('retourne 404 si l\'event n\'existe pas', async () => {
    const res = await request(app)
      .post('/api/sync/push/inexistant')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  it('retourne 409 si l\'event n\'est pas closed', async () => {
    insertEvent({ id: 'ev-live', name: 'Live', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-live', 'live');

    const res = await request(app)
      .post('/api/sync/push/ev-live')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Clôturez/);
  });

  it('retourne { ok: true } et lance le push en tâche de fond', async () => {
    makeClosedEvent(dir, 'ev-push');

    const res = await request(app)
      .post('/api/sync/push/ev-push')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 409 si un push est déjà en cours', async () => {
    makeClosedEvent(dir, 'ev-push-running');

    // Bloquer le push : le manifest ne répond qu'après signal explicite
    let resolveManifest;
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) {
        return new Promise(resolve => { resolveManifest = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    // Lance le 1er push (reste bloqué sur checkpointAndHash + manifest)
    const firstPush = request(app)
      .post('/api/sync/push/ev-push-running')
      .set('Authorization', `Bearer ${token}`);
    // Ne pas await — on veut que ça tourne en fond
    firstPush.end(() => {});

    // Sonder getPushState jusqu'à ce que running=true (max 500ms)
    const statusRes = await new Promise((resolve) => {
      const check = async () => {
        const r = await request(app)
          .get('/api/sync/status')
          .set('Authorization', `Bearer ${token}`);
        if (r.body.push?.running) return resolve(r);
        setTimeout(check, 10);
      };
      check();
    });
    assert.equal(statusRes.body.push.running, true);

    // 2ème tentative → 409
    const res = await request(app)
      .post('/api/sync/push/ev-push-running')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /déjà en cours/);

    // Débloquer le push bloqué pour nettoyage propre
    if (resolveManifest) resolveManifest({ ok: true, status: 200, json: async () => ({ missing: [] }) });
    await new Promise(r => setTimeout(r, 80));
  });

  it('retourne 403 avec un token client (§11.19)', async () => {
    const res = await request(app)
      .post('/api/sync/push/ev-x')
      .set('Authorization', `Bearer ${clientToken}`);
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/sync/push/ev-x');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sync/purge/:eventId ────────────────────────────────────────────

describe('POST /api/sync/purge/:eventId', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne 404 si l\'event n\'existe pas', async () => {
    const res = await request(app)
      .post('/api/sync/purge/inexistant')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'nom' });
    assert.equal(res.status, 404);
  });

  it('retourne 409 si l\'event n\'est pas pushed', async () => {
    insertEvent({ id: 'ev-closed', name: 'Closed', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-closed', 'live');
    updateEventStatus('ev-closed', 'closed');

    const res = await request(app)
      .post('/api/sync/purge/ev-closed')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'Closed' });
    assert.equal(res.status, 409);
  });

  it('retourne 400 si la confirmation est absente', async () => {
    insertEvent({ id: 'ev-pushed', name: 'Pushed Event', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-pushed', 'live');
    updateEventStatus('ev-pushed', 'closed');
    updateEventStatus('ev-pushed', 'pushed');

    const res = await request(app)
      .post('/api/sync/purge/ev-pushed')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it('retourne 400 si la confirmation ne correspond pas au nom', async () => {
    insertEvent({ id: 'ev-pushed2', name: 'Mon Beau Mariage', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-pushed2', 'live');
    updateEventStatus('ev-pushed2', 'closed');
    updateEventStatus('ev-pushed2', 'pushed');

    const res = await request(app)
      .post('/api/sync/purge/ev-pushed2')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'mauvais nom' });
    assert.equal(res.status, 400);
  });

  it('supprime le dossier physique et passe en purged', async () => {
    const eventId = 'ev-to-purge';
    insertEvent({ id: eventId, name: 'À Purger', origin: 'hub', status: 'loaded' });
    updateEventStatus(eventId, 'live');
    updateEventStatus(eventId, 'closed');
    updateEventStatus(eventId, 'pushed');

    // Crée le dossier physique
    const eventDir = join(dir, 'events', eventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    writeFileSync(join(eventDir, 'videos', 'test.mp4'), 'fake video');
    assert.ok(existsSync(eventDir));

    const res = await request(app)
      .post(`/api/sync/purge/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'À Purger' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!existsSync(eventDir), 'le dossier doit être supprimé');

    const ev = getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
    assert.equal(ev.status, 'purged');
  });

  it('nettoie push_state après purge', async () => {
    const eventId = 'ev-purge-state';
    insertEvent({ id: eventId, name: 'Purge State', origin: 'hub', status: 'loaded' });
    updateEventStatus(eventId, 'live');
    updateEventStatus(eventId, 'closed');
    updateEventStatus(eventId, 'pushed');

    // Insère un push_state factice
    getRegistry().prepare(
      'INSERT INTO push_state (event_id, video_id, checksum, uploaded_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(eventId, 'vid-1', 'abc123');

    const res = await request(app)
      .post(`/api/sync/purge/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'Purge State' });

    assert.equal(res.status, 200);
    const ps = getRegistry().prepare('SELECT * FROM push_state WHERE event_id = ?').get(eventId);
    assert.ok(!ps, 'push_state doit être supprimé');
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app)
      .post('/api/sync/purge/ev-x')
      .send({ confirm: 'test' });
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sync/push — garde mode démo (§11.21 / 6D.2) ────────────────────

describe('POST /api/sync/push — mode démo', () => {
  let dir, app, token;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-sync-preview-push-'));
    app = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true });
    token = signTechToken();
    makeClosedEvent(dir, 'ev-preview-push');
  });

  after(() => { closeEventDb(); closeRegistry(); rmSync(dir, { recursive: true, force: true }); });

  it('retourne 409 en mode démo même si l\'event est closed', async () => {
    const res = await request(app)
      .post('/api/sync/push/ev-preview-push')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /mode démo/);
  });
});

// ── POST /api/sync/push-config ───────────────────────────────────────────────

describe('POST /api/sync/push-config', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne 404 si aucun événement actif', async () => {
    const res = await request(app)
      .post('/api/sync/push-config')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /événement actif/);
  });

  it('retourne { ok: true } quand un événement actif existe', async () => {
    const eventId = 'ev-push-config';
    const eventDir = join(dir, 'events', eventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    edb.close();
    insertEvent({ id: eventId, name: 'Push Config Test', origin: 'hub', status: 'loaded' });
    const { setActiveEvent } = await import('../src/registry.js');
    setActiveEvent(eventId);

    const res = await request(app)
      .post('/api/sync/push-config')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/sync/push-config');
    assert.equal(res.status, 401);
  });

  it('retourne 403 en mode preview (write-back interdit)', async () => {
    teardown(dir);
    dir = mkdtempSync(join(tmpdir(), 'borne-sync-pushcfg-preview-'));
    const previewApp = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true });
    const res = await request(previewApp)
      .post('/api/sync/push-config')
      .set('Authorization', `Bearer ${signTechToken()}`);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /interdit.*mode démo/);
  });
});

// ── POST /api/sync/reset-preview (§11.21 / 6D.3) ─────────────────────────────

describe('POST /api/sync/reset-preview', () => {
  let dir, app, token;

  async function setupPreviewApp() {
    dir = mkdtempSync(join(tmpdir(), 'borne-sync-reset-'));
    app = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true });
    token = signTechToken();
  }

  afterEach(() => { closeEventDb(); closeRegistry(); rmSync(dir, { recursive: true, force: true }); });

  it('retourne 403 hors mode démo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-sync-reset-nopreview-'));
    app = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: false });
    token = signTechToken();

    const res = await request(app)
      .post('/api/sync/reset-preview')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  it('retourne 404 si aucun événement actif', async () => {
    await setupPreviewApp();
    const res = await request(app)
      .post('/api/sync/reset-preview')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  it('purge sessions et vidéos sans toucher aux questions', async () => {
    await setupPreviewApp();

    // Crée un événement actif avec sessions et vidéos
    const eventId = 'ev-reset-preview';
    const eventDir = join(dir, 'events', eventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    // Plus de questions seedées par défaut → en créer une explicitement pour la FK videos.question_id
    edb.prepare("INSERT INTO questions (id, text) VALUES (1, 'Q1')").run();
    edb.prepare("INSERT INTO sessions (id, guest_name, consent_at) VALUES ('s1','Alice',CURRENT_TIMESTAMP)").run();
    edb.prepare("INSERT INTO videos (id,session_id,question_id,question_text,filename,mime_type,size,checksum) VALUES ('v1','s1',1,'Q1','f.mp4','video/mp4',100,'abc')").run();
    // Crée un fichier vidéo fictif
    writeFileSync(join(eventDir, 'videos', 'f.mp4'), 'fake');
    edb.close();

    insertEvent({ id: eventId, name: 'Evt Preview', origin: 'hub', status: 'loaded' });
    const { setActiveEvent } = await import('../src/registry.js');
    setActiveEvent(eventId);

    const res = await request(app)
      .post('/api/sync/reset-preview')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);

    const { getActiveEventDb } = await import('../src/eventDb.js');
    const { getActiveEvent } = await import('../src/registry.js');
    const active = getActiveEvent();
    const db2 = getActiveEventDb(dir, active);
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM videos').get().n, 0);
    assert.ok(!existsSync(join(eventDir, 'videos', 'f.mp4')), 'fichier vidéo supprimé');
  });
});
