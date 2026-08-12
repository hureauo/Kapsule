import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/index.js';
import {
  getDb, closeRegistry, insertUser, insertBoxToken, getBoxTokenByHash, getEvent,
  upsertEventUser, deleteEventUser, updateEvent,
  insertBorne, getBorneByHash, assignBorneEvent, insertBorneCommand, listBorneCommands,
} from '../src/registry.js';
import { closeAllEventDbs, openEventDb, cacheSize } from '../src/eventStore.js';

let dir, request;
let tokenAdmin, tokenClient;
let boxToken;
let eventId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-sync-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();

  // Utilisateurs
  const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
  const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
  insertUser(db, { email: 'admin@sync.test', password_hash: hashAdmin,  role: 'superuser' });
  insertUser(db, { email: 'client@sync.test', password_hash: hashClient, role: 'client' });

  const r1 = await request.post('/api/auth/login').send({ email: 'admin@sync.test',  password: 'admin-pass' });
  const r2 = await request.post('/api/auth/login').send({ email: 'client@sync.test', password: 'client-pass' });
  tokenAdmin  = r1.body.token;
  tokenClient = r2.body.token;

  // Événement en statut 'ready' (création réservée aux admins §6E)
  const evRes = await request.post('/api/events')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ name: 'Événement Sync', event_date: '2026-09-01' });
  eventId = evRes.body.id;

  await request.put(`/api/events/${eventId}/status`)
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ status: 'preview' });
  await request.put(`/api/events/${eventId}/status`)
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ status: 'ready' });

  // Token de borne lié à cet événement (modèle 6C : token = événement §11.20)
  const raw = 'a'.repeat(64);
  const hash = createHash('sha256').update(raw).digest('hex');
  insertBoxToken(db, { event_id: eventId, token_hash: hash, token_clear: raw, label: 'Borne Sync Test' });
  boxToken = raw;
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── requireBox — middleware ────────────────────────────────────────────────────

describe('requireBox — middleware (via GET /api/sync/event)', () => {
  it('retourne 401 si X-Box-Token absent', async () => {
    const res = await request.get('/api/sync/event');
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  it('retourne 401 si token invalide', async () => {
    const res = await request.get('/api/sync/event')
      .set('X-Box-Token', 'token-bidon-inexistant');
    assert.equal(res.status, 401);
  });

  it('met à jour last_seen_at avec un token valide', async () => {
    const db = getDb();
    const hash = createHash('sha256').update(boxToken).digest('hex');
    const before = getBoxTokenByHash(db, hash).last_seen_at;

    await request.get('/api/sync/event').set('X-Box-Token', boxToken);

    const after = getBoxTokenByHash(db, hash).last_seen_at;
    assert.ok(after !== null, 'last_seen_at doit être défini après un appel');
    if (before !== null) assert.ok(after >= before);
  });
});

// ── GET /api/sync/event ──────────────────────────────────────────────────────

describe('GET /api/sync/event', () => {
  it("retourne l'événement prêt lié à ce token (200)", async () => {
    const res = await request.get('/api/sync/event')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, eventId);
    assert.equal(res.body.status, 'ready');
    assert.ok('name' in res.body);
    assert.ok('updated_at' in res.body);
    assert.ok('is_preview' in res.body);
  });

  it("retourne 404 si l'événement n'est pas pullable (waiting)", async () => {
    const db = getDb();
    const evWaiting = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Waiting event' });
    updateEvent(db, evWaiting.body.id, { status: 'waiting' });
    const rawWaiting = randomBytes(32).toString('hex');
    const hashWaiting = createHash('sha256').update(rawWaiting).digest('hex');
    insertBoxToken(db, { event_id: evWaiting.body.id, token_hash: hashWaiting, token_clear: rawWaiting, label: 'waiting token' });

    const res = await request.get('/api/sync/event')
      .set('X-Box-Token', rawWaiting);
    assert.equal(res.status, 404);
  });
});

// ── POST /api/sync/event/login ────────────────────────────────────────────────

describe('POST /api/sync/event/login', () => {
  let previewEventId, previewBoxToken, generalUserHash;

  before(async () => {
    const db = getDb();
    generalUserHash = await argon2.hash('guest-pass', { type: argon2.argon2id });

    // Event en statut 'preview' avec un token preview
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Event Preview Login', event_date: '2026-10-01' });
    previewEventId = evRes.body.id;
    await request.put(`/api/events/${previewEventId}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'preview' });

    const raw = 'p'.repeat(64);
    const hash = createHash('sha256').update(raw).digest('hex');
    insertBoxToken(db, { event_id: previewEventId, token_hash: hash, token_clear: raw, label: 'Preview Login Token', is_preview: 1 });
    previewBoxToken = raw;

    // Créer un user 'general' et l'assigner à l'event preview
    insertUser(db, { email: 'guest@preview.test', password_hash: generalUserHash, role: 'client' });
    const guestUser = db.prepare("SELECT id FROM users WHERE email = 'guest@preview.test'").get();
    upsertEventUser(db, { event_id: previewEventId, user_id: guestUser.id, roles: ['general'] });
  });

  it('retourne 400 si email manquant', async () => {
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ password: 'guest-pass' });
    assert.equal(res.status, 400);
  });

  it('retourne 400 si password manquant', async () => {
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ email: 'guest@preview.test' });
    assert.equal(res.status, 400);
  });

  it('retourne 403 si event non en preview (token réel)', async () => {
    // boxToken pointe sur eventId qui est en 'loaded' après le bundle pull
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', boxToken)
      .send({ email: 'guest@preview.test', password: 'guest-pass' });
    assert.equal(res.status, 403);
  });

  it('retourne 401 si mdp incorrect', async () => {
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ email: 'guest@preview.test', password: 'mauvais' });
    assert.equal(res.status, 401);
  });

  it('retourne 401 si email inconnu', async () => {
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ email: 'inconnu@test.com', password: 'guest-pass' });
    assert.equal(res.status, 401);
  });

  it('retourne 403 si user non assigné à cet event avec rôle general', async () => {
    // client@sync.test existe mais n'est pas assigné à previewEventId
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ email: 'client@sync.test', password: 'client-pass' });
    assert.equal(res.status, 403);
  });

  it('retourne 200 si user assigné general + mdp correct', async () => {
    const res = await request.post('/api/sync/event/login')
      .set('X-Box-Token', previewBoxToken)
      .send({ email: 'guest@preview.test', password: 'guest-pass' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

// ── GET /api/sync/events/:id/bundle ─────────────────────────────────────────

describe('GET /api/sync/events/:id/bundle', () => {
  it('retourne le bundle et passe ready→loaded', async () => {
    const res = await request.get(`/api/sync/events/${eventId}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.event, 'event doit être présent');
    assert.ok(Array.isArray(res.body.questions), 'questions doit être un tableau');

    // Transition ready→loaded
    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'loaded');
    assert.ok(event.pulled_at, 'pulled_at doit être défini');
  });

  it('retourne 200 si déjà loaded (idempotent)', async () => {
    const res = await request.get(`/api/sync/events/${eventId}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'loaded');
  });

  it('retourne 404 pour un événement inexistant', async () => {
    const res = await request.get('/api/sync/events/11111111-1111-4111-8111-111111111111/bundle')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 404);
  });

  it("retourne 403 si le token n'est pas lié à cet événement", async () => {
    // Créer un événement B avec son propre token B
    const db = getDb();
    const evB = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement borne B' });
    await request.put(`/api/events/${evB.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    const rawB = 'b'.repeat(64);
    const hashB = createHash('sha256').update(rawB).digest('hex');
    insertBoxToken(db, { event_id: evB.body.id, token_hash: hashB, token_clear: rawB, label: 'Borne B' });

    // boxToken (lié à eventId) tente d'accéder à l'événement B → 403
    const res = await request.get(`/api/sync/events/${evB.body.id}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 403);
  });

  it("retourne 409 si le statut n'est pas ready ou loaded", async () => {
    // Un event en preview avec token réel (non-preview) → 409
    const db = getDb();
    const evPreview = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement preview non-ready' });
    const rawD = 'd'.repeat(64);
    const hashD = createHash('sha256').update(rawD).digest('hex');
    insertBoxToken(db, { event_id: evPreview.body.id, token_hash: hashD, token_clear: rawD, label: 'Borne réelle' });

    const res = await request.get(`/api/sync/events/${evPreview.body.id}/bundle`)
      .set('X-Box-Token', rawD);
    assert.equal(res.status, 409);
  });

  it('inclut users dans le bundle — superusers (sans general), clients sans hash exclus, requiresLogin', async () => {
    const db = getDb();

    // Créer un événement dédié avec token
    const evU = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement users bundle' });
    await request.put(`/api/events/${evU.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'preview' });
    await request.put(`/api/events/${evU.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    const rawU = 'u'.repeat(64);
    const hashU = createHash('sha256').update(rawU).digest('hex');
    insertBoxToken(db, { event_id: evU.body.id, token_hash: hashU, token_clear: rawU, label: 'Borne U' });

    // Ajouter un client sans hash avec rôle general → ne doit PAS être dans users,
    // mais déclenche requiresLogin: true (auth wall proxié vers Hub)
    const noHashId = insertUser(db, { email: 'nohash@sync.test', role: 'client' });
    upsertEventUser(db, { event_id: evU.body.id, user_id: noHashId.lastInsertRowid, roles: ['general'] });

    const res = await request.get(`/api/sync/events/${evU.body.id}/bundle`)
      .set('X-Box-Token', rawU);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users), 'users doit être un tableau');

    const emails = res.body.users.map(u => u.email);
    // admin@sync.test est superuser → toujours dans le bundle avec rôles borne (sans general)
    assert.ok(emails.includes('admin@sync.test'), 'superuser doit être dans le bundle');
    assert.ok(!emails.includes('nohash@sync.test'), 'client sans hash ne doit pas être dans le bundle');

    const adminUser = res.body.users.find(u => u.email === 'admin@sync.test');
    assert.ok(adminUser.password_hash, 'password_hash doit être présent');
    // Les superusers ont admin_borne + tech_borne (sans general — général proxié vers Hub, §11.24)
    assert.deepEqual(adminUser.roles, ['admin_borne', 'tech_borne']);

    // requiresLogin = true car un user avec rôle general est assigné
    assert.equal(res.body.requiresLogin, true);
  });

  it('bundle.users contient toujours les superusers actifs, même sans event_users', async () => {
    const db = getDb();
    const evEmpty = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement sans users client' });
    await request.put(`/api/events/${evEmpty.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'preview' });
    await request.put(`/api/events/${evEmpty.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    const rawEmp = 'e'.repeat(62) + 'mp';
    const hashEmp = createHash('sha256').update(rawEmp).digest('hex');
    insertBoxToken(db, { event_id: evEmpty.body.id, token_hash: hashEmp, token_clear: rawEmp, label: 'Borne Empty' });

    // Retirer tous les event_users (y compris l'admin auto-assigné)
    const adminRow = db.prepare("SELECT id FROM users WHERE email = 'admin@sync.test'").get();
    deleteEventUser(db, { event_id: evEmpty.body.id, user_id: adminRow.id });

    // Assigner uniquement un client sans hash (rôle general)
    const noHash2 = insertUser(db, { email: 'nohash2@sync.test', role: 'client' });
    upsertEventUser(db, { event_id: evEmpty.body.id, user_id: noHash2.lastInsertRowid, roles: ['general'] });

    const res = await request.get(`/api/sync/events/${evEmpty.body.id}/bundle`)
      .set('X-Box-Token', rawEmp);
    assert.equal(res.status, 200);
    // Le superuser (admin@sync.test) est toujours inclus même retiré d'event_users
    const emails = res.body.users.map(u => u.email);
    assert.ok(emails.includes('admin@sync.test'), 'superuser toujours présent dans le bundle');
    assert.ok(!emails.includes('nohash2@sync.test'), 'client sans hash absent du bundle');
    // requiresLogin = true car nohash2 a le rôle general
    assert.equal(res.body.requiresLogin, true);
  });
});

// ── POST /api/sync/events/:id/status ────────────────────────────────────────

describe('POST /api/sync/events/:id/status (heartbeat)', () => {
  it('passe loaded→live', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'live');

    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'live');
  });

  it('passe live→closed', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'closed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
  });

  it('refuse un retour en arrière (closed→live)', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 409);
  });

  it('retourne 400 pour un statut invalide', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'draft' });
    assert.equal(res.status, 400);
  });

  it('retourne 400 pour un statut hors heartbeat (pushed)', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'pushed' });
    assert.equal(res.status, 400);
  });

  it('retourne 404 pour un événement inexistant', async () => {
    const res = await request.post('/api/sync/events/11111111-1111-4111-8111-111111111111/status')
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 404);
  });

  it("retourne 403 si le token n'est pas lié à cet événement", async () => {
    const db = getDb();
    const rawC = 'c'.repeat(64);
    const hashC = createHash('sha256').update(rawC).digest('hex');
    const evC = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement borne C' });
    await request.put(`/api/events/${evC.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    insertBoxToken(db, { event_id: evC.body.id, token_hash: hashC, token_clear: rawC, label: 'Borne C' });
    // pull pour passer en loaded
    await request.get(`/api/sync/events/${evC.body.id}/bundle`).set('X-Box-Token', rawC);

    // boxToken (lié à eventId) tente d'accéder à l'événement C → 403
    const res = await request.post(`/api/sync/events/${evC.body.id}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 403);
  });

  it('insère une entrée sync_log action=status pour le heartbeat', async () => {
    const db = getDb();
    const rawE = 'e'.repeat(64);
    const hashE = createHash('sha256').update(rawE).digest('hex');
    const ev5 = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement log test' });
    await request.put(`/api/events/${ev5.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    insertBoxToken(db, { event_id: ev5.body.id, token_hash: hashE, token_clear: rawE, label: 'Log test' });
    // Pull pour passer en loaded
    await request.get(`/api/sync/events/${ev5.body.id}/bundle`).set('X-Box-Token', rawE);

    const countBefore = db.prepare('SELECT COUNT(*) as n FROM sync_log WHERE event_id = ?').get(ev5.body.id).n;

    await request.post(`/api/sync/events/${ev5.body.id}/status`)
      .set('X-Box-Token', rawE)
      .send({ status: 'live' });

    const rows = db.prepare('SELECT * FROM sync_log WHERE event_id = ? ORDER BY id DESC').all(ev5.body.id);
    assert.ok(rows.length > countBefore, 'une ligne sync_log doit être insérée');
    assert.equal(rows[0].action, 'status', 'l\'action doit être "status"');
  });
});

// ── Helpers pour les tests push ───────────────────────────────────────────────

// Crée un événement en état 'closed' avec son propre token de borne.
// Retourne { id, token } — chaque événement a son propre token (§11.20).
async function makeClosedEvent(req, db, _unusedToken, name) {
  const ev = await req.post('/api/events')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ name });
  const id = ev.body.id;
  await req.put(`/api/events/${id}/status`).set('Authorization', `Bearer ${tokenAdmin}`).send({ status: 'ready' });

  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  insertBoxToken(db, { event_id: id, token_hash: hash, token_clear: raw, label: name });

  await req.get(`/api/sync/events/${id}/bundle`).set('X-Box-Token', raw);      // loaded
  await req.post(`/api/sync/events/${id}/status`).set('X-Box-Token', raw).send({ status: 'live' });
  await req.post(`/api/sync/events/${id}/status`).set('X-Box-Token', raw).send({ status: 'closed' });
  return { id, token: raw };
}

// ── POST /api/sync/events/:id/manifest ──────────────────────────────────────

describe('POST /api/sync/events/:id/manifest', () => {
  let manifestEventId, manifestBoxToken;

  before(async () => {
    const ev = await makeClosedEvent(request, getDb(), tokenAdmin, 'Push manifest test');
    manifestEventId = ev.id;
    manifestBoxToken = ev.token;
  });

  it('retourne { missing: [] } si aucun fichier annoncé', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', manifestBoxToken)
      .send({ files: [], db: { size: 1000, checksum: 'abc' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing, []);
  });

  it('retourne les video_id manquants', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', manifestBoxToken)
      .send({
        files: [
          { video_id: 'vid-001', filename: 'vid-001.mp4', size: 100, checksum: 'aaa' },
          { video_id: 'vid-002', filename: 'vid-002.mp4', size: 200, checksum: 'bbb' },
        ],
        db: { size: 1000, checksum: 'ccc' },
      });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing.sort(), ['vid-001', 'vid-002']);
  });

  it('ne retourne pas un fichier déjà présent avec le bon checksum', async () => {
    const content = randomBytes(32);
    const hash = createHash('sha256').update(content).digest('hex');
    const videosDir = join(dir, 'events', manifestEventId, 'videos');
    mkdirSync(videosDir, { recursive: true });
    writeFileSync(join(videosDir, 'vid-existing.mp4'), content);

    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', manifestBoxToken)
      .send({
        files: [
          { video_id: 'vid-existing', filename: 'vid-existing.mp4', size: content.length, checksum: hash },
          { video_id: 'vid-missing', filename: 'vid-missing.mp4', size: 100, checksum: 'xxx' },
        ],
        db: { size: 100, checksum: 'yyy' },
      });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing, ['vid-missing']);
  });

  it("retourne 409 si le statut n'est pas closed/pushed", async () => {
    // Utilise un événement en statut 'loaded' avec son token
    const db = getDb();
    const evLoaded = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Loaded event' });
    await request.put(`/api/events/${evLoaded.body.id}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`).send({ status: 'ready' });
    const rawL = randomBytes(32).toString('hex');
    insertBoxToken(db, { event_id: evLoaded.body.id, token_hash: createHash('sha256').update(rawL).digest('hex'), token_clear: rawL, label: 'loaded' });
    await request.get(`/api/sync/events/${evLoaded.body.id}/bundle`).set('X-Box-Token', rawL);

    const res = await request.post(`/api/sync/events/${evLoaded.body.id}/manifest`)
      .set('X-Box-Token', rawL)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
    assert.equal(res.status, 409);
  });

  it('retourne 400 si body invalide', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', manifestBoxToken)
      .send({ files: [] }); // db manquant
    assert.equal(res.status, 400);
  });
});

// ── PUT /api/sync/events/:id/files/:videoId ──────────────────────────────────

describe('PUT /api/sync/events/:id/files/:videoId', () => {
  let uploadEventId, uploadBoxToken;

  before(async () => {
    const ev = await makeClosedEvent(request, getDb(), tokenAdmin, 'Upload vidéo test');
    uploadEventId = ev.id;
    uploadBoxToken = ev.token;
    await request.post(`/api/sync/events/${uploadEventId}/manifest`)
      .set('X-Box-Token', uploadBoxToken)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
  });

  it('accepte un fichier vidéo et retourne son checksum', async () => {
    const vidId = uuidv4();
    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${uploadEventId}/files/${vidId}`)
      .set('X-Box-Token', uploadBoxToken)
      .attach('file', content, `${vidId}.mp4`);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.video_id, vidId);
    assert.ok(res.body.checksum, 'checksum doit être présent');
  });

  it('retourne 422 si checksum mismatch', async () => {
    const badVid = uuidv4();
    const wrongChecksum = 'a'.repeat(64);
    const evMismatch = await makeClosedEvent(request, getDb(), tokenAdmin, 'Checksum mismatch');
    await request.post(`/api/sync/events/${evMismatch.id}/manifest`)
      .set('X-Box-Token', evMismatch.token)
      .send({ files: [{ video_id: badVid, filename: `${badVid}.mp4`, size: 10, checksum: wrongChecksum }], db: { size: 0, checksum: 'x' } });

    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${evMismatch.id}/files/${badVid}`)
      .set('X-Box-Token', evMismatch.token)
      .attach('file', content, `${badVid}.mp4`);
    assert.equal(res.status, 422);
  });

  it('retourne 400 si aucun fichier joint', async () => {
    const res = await request.put(`/api/sync/events/${uploadEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', uploadBoxToken);
    assert.equal(res.status, 400);
  });
});

// ── PUT /api/sync/events/:id/db ──────────────────────────────────────────────

describe('PUT /api/sync/events/:id/db', () => {
  let dbUploadEventId, dbUploadBoxToken;

  before(async () => {
    const ev = await makeClosedEvent(request, getDb(), tokenAdmin, 'Upload db test');
    dbUploadEventId = ev.id;
    dbUploadBoxToken = ev.token;
  });

  it('écrase db.sqlite et ferme le handle LRU (§11.11)', async () => {
    openEventDb(dbUploadEventId, dir);
    const sizeBefore = cacheSize();
    assert.ok(sizeBefore >= 1, 'le handle doit être en cache avant le PUT');

    const content = randomBytes(64);
    const hash = createHash('sha256').update(content).digest('hex');

    await request.post(`/api/sync/events/${dbUploadEventId}/manifest`)
      .set('X-Box-Token', dbUploadBoxToken)
      .send({ files: [], db: { size: content.length, checksum: hash } });

    const res = await request.put(`/api/sync/events/${dbUploadEventId}/db`)
      .set('X-Box-Token', dbUploadBoxToken)
      .attach('file', content, 'db.sqlite');
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.checksum, hash);

    assert.equal(cacheSize(), sizeBefore - 1, 'closeEventDb doit avoir retiré le handle du cache');

    const dbPath = join(dir, 'events', dbUploadEventId, 'db.sqlite');
    assert.ok(existsSync(dbPath), 'db.sqlite doit exister après PUT /db');
  });

  it('retourne 422 si checksum db mismatch', async () => {
    const evDbMismatch = await makeClosedEvent(request, getDb(), tokenAdmin, 'DB mismatch');
    const wrongHash = 'b'.repeat(64);
    await request.post(`/api/sync/events/${evDbMismatch.id}/manifest`)
      .set('X-Box-Token', evDbMismatch.token)
      .send({ files: [], db: { size: 10, checksum: wrongHash } });

    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${evDbMismatch.id}/db`)
      .set('X-Box-Token', evDbMismatch.token)
      .attach('file', content, 'db.sqlite');
    assert.equal(res.status, 422);
  });
});

// ── POST /api/sync/events/:id/finalize ───────────────────────────────────────

describe('POST /api/sync/events/:id/finalize', () => {
  let finalizeEventId, finalizeBoxToken;

  before(async () => {
    const ev = await makeClosedEvent(request, getDb(), tokenAdmin, 'Finalize test');
    finalizeEventId = ev.id;
    finalizeBoxToken = ev.token;

    const fVid1 = uuidv4();
    const fVid2 = uuidv4();
    const vid1 = randomBytes(32);
    const vid2 = randomBytes(32);
    const dbContent = randomBytes(32);
    const h1 = createHash('sha256').update(vid1).digest('hex');
    const h2 = createHash('sha256').update(vid2).digest('hex');
    const hdb = createHash('sha256').update(dbContent).digest('hex');

    await request.post(`/api/sync/events/${finalizeEventId}/manifest`)
      .set('X-Box-Token', finalizeBoxToken)
      .send({
        files: [
          { video_id: fVid1, filename: `${fVid1}.mp4`, size: vid1.length, checksum: h1 },
          { video_id: fVid2, filename: `${fVid2}.mp4`, size: vid2.length, checksum: h2 },
        ],
        db: { size: dbContent.length, checksum: hdb },
      });

    await request.put(`/api/sync/events/${finalizeEventId}/files/${fVid1}`)
      .set('X-Box-Token', finalizeBoxToken).attach('file', vid1, `${fVid1}.mp4`);
    await request.put(`/api/sync/events/${finalizeEventId}/files/${fVid2}`)
      .set('X-Box-Token', finalizeBoxToken).attach('file', vid2, `${fVid2}.mp4`);
    await request.put(`/api/sync/events/${finalizeEventId}/db`)
      .set('X-Box-Token', finalizeBoxToken).attach('file', dbContent, 'db.sqlite');
  });

  it("passe l'événement en pushed et enfile les jobs", async () => {
    const res = await request.post(`/api/sync/events/${finalizeEventId}/finalize`)
      .set('X-Box-Token', finalizeBoxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.jobs, 5, '2 probe + 2 thumbnail + 1 archive = 5 jobs');

    const db = getDb();
    const event = getEvent(db, finalizeEventId);
    assert.equal(event.status, 'pushed');
    assert.ok(event.pushed_at);

    const jobs = db.prepare('SELECT * FROM jobs WHERE event_id = ?').all(finalizeEventId);
    assert.equal(jobs.length, 5);
    const types = jobs.map(j => j.type).sort();
    assert.deepEqual(types, ['archive', 'probe', 'probe', 'thumbnail', 'thumbnail']);
  });

  it('retourne 409 si des fichiers sont encore manquants', async () => {
    const evPartial = await makeClosedEvent(request, getDb(), tokenAdmin, 'Partial push');
    await request.post(`/api/sync/events/${evPartial.id}/manifest`)
      .set('X-Box-Token', evPartial.token)
      .send({ files: [{ video_id: 'missing-vid', filename: 'missing.mp4', size: 10, checksum: 'z'.repeat(64) }], db: { size: 0, checksum: 'z'.repeat(64) } });

    const res = await request.post(`/api/sync/events/${evPartial.id}/finalize`)
      .set('X-Box-Token', evPartial.token);
    assert.equal(res.status, 409);
    assert.ok(res.body.missing || res.body.error);
  });

  it('retourne 409 si manifest absent', async () => {
    const evNoManifest = await makeClosedEvent(request, getDb(), tokenAdmin, 'No manifest');
    const res = await request.post(`/api/sync/events/${evNoManifest.id}/finalize`)
      .set('X-Box-Token', evNoManifest.token);
    assert.equal(res.status, 409);
  });

  it('est idempotent : pushed→pushed ne ré-insère pas les jobs', async () => {
    const db = getDb();
    const jobsBefore = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE event_id = ?').get(finalizeEventId).n;

    const res = await request.post(`/api/sync/events/${finalizeEventId}/finalize`)
      .set('X-Box-Token', finalizeBoxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(res.body.alreadyPushed, 'doit indiquer alreadyPushed=true');

    const jobsAfter = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE event_id = ?').get(finalizeEventId).n;
    assert.equal(jobsAfter, jobsBefore, 'aucun job supplémentaire ne doit être inséré');
  });
});

// ── validateUuidParams — anti path traversal (SECURITY.md H1) ──────────────────

describe('validateUuidParams — rejet des params non-UUID avant tout accès disque', () => {
  it('rejette :id = ".." (400) sur le bundle', async () => {
    const res = await request.get('/api/sync/events/..%2f..%2f..%2fetc/bundle')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /id invalide/);
  });

  it('rejette :id non-UUID (400) sur le manifest', async () => {
    const res = await request.post('/api/sync/events/pas-un-uuid/manifest')
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 1, checksum: 'x' } });
    assert.equal(res.status, 400);
  });

  it('rejette :videoId malformé (400) sans écrire de fichier hors du dossier', async () => {
    const res = await request.put(`/api/sync/events/${eventId}/files/..%2f..%2f..%2fevil`)
      .set('X-Box-Token', boxToken)
      .attach('file', Buffer.from('malveillant'), 'evil.mp4');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /videoId invalide/);
    assert.ok(!existsSync(join(dir, 'evil')), 'aucun fichier ne doit sortir du dossier événement');
    assert.ok(!existsSync(join(dir, 'evil.mp4')), 'aucun fichier ne doit sortir du dossier événement');
  });

  it('exige le token borne avant la validation des params (401 prioritaire)', async () => {
    const res = await request.put('/api/sync/events/pas-un-uuid/files/pas-un-uuid').send({});
    assert.equal(res.status, 401);
  });

  it('accepte un :id UUID valide (pas de 400 de validation)', async () => {
    // UUID bien formé mais absent ou non autorisé → pas 400
    const res = await request.get('/api/sync/events/00000000-0000-4000-8000-000000000000/bundle')
      .set('X-Box-Token', boxToken);
    assert.notEqual(res.status, 400);
  });
});

// ── Limite de taille d'upload (SECURITY.md M2 / S3.1) ─────────────────────────

describe("limite de taille d'upload sync (anti-DoS disque)", () => {
  let smallApp, smallEventId, smallBoxToken;
  const MAX = 1024;

  before(async () => {
    smallApp = supertest(createApp(dir, { sync: { maxUploadBytes: MAX } }));
    const ev = await makeClosedEvent(smallApp, getDb(), tokenClient, 'Upload limit test');
    smallEventId = ev.id;
    smallBoxToken = ev.token;
    await smallApp.post(`/api/sync/events/${smallEventId}/manifest`)
      .set('X-Box-Token', smallBoxToken)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
  });

  it('rejette une vidéo dépassant la limite (413)', async () => {
    const tooBig = randomBytes(MAX + 512);
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', smallBoxToken)
      .attach('file', tooBig, 'big.mp4');
    assert.equal(res.status, 413);
    assert.match(res.body.error, /Upload refusé/);
  });

  it('rejette un db.sqlite dépassant la limite (413)', async () => {
    const tooBig = randomBytes(MAX + 512);
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/db`)
      .set('X-Box-Token', smallBoxToken)
      .attach('file', tooBig, 'db.sqlite');
    assert.equal(res.status, 413);
  });

  it('accepte un fichier sous la limite', async () => {
    const ok = randomBytes(256);
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', smallBoxToken)
      .attach('file', ok, 'small.mp4');
    assert.equal(res.status, 200);
  });
});

// ── Phase B — bornes physiques (token = machine, plusieurs événements) ────────
// requireBox doit résoudre box_tokens ET bornes ; les routes preview existantes
// (GET /event, POST /event/login, bundle, manifest, files, db, finalize) ne
// doivent PAS changer de comportement pour un token preview — c'est la
// non-régression vérifiée ci-dessous, avec des fixtures locales à ce bloc
// (indépendantes du eventId/boxToken globaux, mutés par les describes précédents).

describe('Phase B — bornes physiques (requireBox résout box_tokens ET bornes)', () => {
  let previewToken, previewEventId; // fixture preview LOCALE, pour la non-régression
  let borneToken, borneId, borneEventId;

  before(async () => {
    const db = getDb();

    // Fixture preview locale, jamais mutée par les autres describes du fichier.
    const evPreview = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement preview (non-régression Phase B)' });
    previewEventId = evPreview.body.id;
    await request.put(`/api/events/${previewEventId}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });
    const rawPreview = randomBytes(32).toString('hex');
    insertBoxToken(db, {
      event_id: previewEventId,
      token_hash: createHash('sha256').update(rawPreview).digest('hex'),
      token_clear: rawPreview,
      label: 'Preview non-régression',
    });
    previewToken = rawPreview;

    // Une borne physique, avec un événement assigné amené à 'ready'.
    const evBorne = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement Borne Physique' });
    borneEventId = evBorne.body.id;
    await request.put(`/api/events/${borneEventId}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });

    const rawBorne = randomBytes(32).toString('hex');
    borneId = 'borne-sync-test';
    insertBorne(db, {
      id: borneId, name: 'Borne Test',
      token_hash: createHash('sha256').update(rawBorne).digest('hex'),
      token_clear: rawBorne,
    });
    assignBorneEvent(db, { borne_id: borneId, event_id: borneEventId });
    borneToken = rawBorne;
  });

  it('non-régression : GET /api/sync/event marche toujours pour un token preview', async () => {
    const res = await request.get('/api/sync/event').set('X-Box-Token', previewToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, previewEventId);
  });

  it('un token borne inconnu retourne 401', async () => {
    const res = await request.get('/api/sync/borne/events').set('X-Box-Token', 'inconnu');
    assert.equal(res.status, 401);
  });

  it('une borne désactivée (active=0) est rejetée avec 401', async () => {
    const db = getDb();
    db.prepare('UPDATE bornes SET active = 0 WHERE id = ?').run(borneId);
    const res = await request.get('/api/sync/borne/events').set('X-Box-Token', borneToken);
    assert.equal(res.status, 401);
    db.prepare('UPDATE bornes SET active = 1 WHERE id = ?').run(borneId);
  });

  it('GET /api/sync/borne/events liste les événements pullables assignés à la borne', async () => {
    const res = await request.get('/api/sync/borne/events').set('X-Box-Token', borneToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].id, borneEventId);
    assert.equal(res.body.events[0].status, 'ready');
  });

  it('GET /api/sync/event (route preview) refuse un token borne (400)', async () => {
    const res = await request.get('/api/sync/event').set('X-Box-Token', borneToken);
    assert.equal(res.status, 400);
  });

  it('GET /api/sync/borne/events refuse un token preview (400)', async () => {
    const res = await request.get('/api/sync/borne/events').set('X-Box-Token', previewToken);
    assert.equal(res.status, 400);
  });

  it('un token borne peut puller le bundle d\'un événement qui lui est assigné', async () => {
    const res = await request.get(`/api/sync/events/${borneEventId}/bundle`).set('X-Box-Token', borneToken);
    assert.equal(res.status, 200);
    const updated = getEvent(getDb(), borneEventId);
    assert.equal(updated.status, 'loaded', 'ready→loaded doit se déclencher pour un token borne aussi');
  });

  it('un token borne reçoit 403 sur un événement qui ne lui est PAS assigné', async () => {
    const res = await request.get(`/api/sync/events/${previewEventId}/bundle`).set('X-Box-Token', borneToken);
    assert.equal(res.status, 403);
  });

  it('POST /api/sync/borne/heartbeat écrit la télémétrie et retourne les commandes en attente', async () => {
    const db = getDb();
    insertBorneCommand(db, { borne_id: borneId, type: 'pull' });

    const res = await request.post('/api/sync/borne/heartbeat')
      .set('X-Box-Token', borneToken)
      .send({ agent_version: '1.2.3', disk: { free: 111, total: 222 }, borne_time_ms: Date.now() - 3000, active_event_id: borneEventId });
    assert.equal(res.status, 200);
    assert.equal(res.body.commands.length, 1);
    assert.equal(res.body.commands[0].type, 'pull');

    const borneRow = getBorneByHash(db, createHash('sha256').update(borneToken).digest('hex'));
    assert.equal(borneRow.agent_version, '1.2.3');
    assert.equal(borneRow.disk_free_bytes, 111);
    assert.equal(borneRow.active_event_id, borneEventId);
    assert.ok(borneRow.last_seen_at !== null);
    // clock_skew_ms calculé côté Hub (Date.now() - borne_time_ms) — pas transmis
    // tel quel par la borne (§11.16, pas d'horloge de référence locale fiable).
    assert.equal(typeof borneRow.clock_skew_ms, 'number');
    assert.ok(borneRow.clock_skew_ms >= 2000 && borneRow.clock_skew_ms < 10000, `skew plausible ~3000ms, reçu ${borneRow.clock_skew_ms}`);
  });

  it('POST /api/sync/borne/heartbeat ne renvoie pas deux fois la même commande', async () => {
    const res = await request.post('/api/sync/borne/heartbeat').set('X-Box-Token', borneToken).send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.commands, []);
  });

  it('POST /api/sync/borne/heartbeat refuse un token preview (400)', async () => {
    const res = await request.post('/api/sync/borne/heartbeat').set('X-Box-Token', previewToken).send({});
    assert.equal(res.status, 400);
  });

  it('POST /api/sync/borne/commands/:id/result marque la commande terminée', async () => {
    const db = getDb();
    const target = listBorneCommands(db, borneId).find((c) => c.type === 'pull');

    const res = await request.post(`/api/sync/borne/commands/${target.id}/result`)
      .set('X-Box-Token', borneToken)
      .send({ status: 'done', result: { ok: true } });
    assert.equal(res.status, 200);

    const updated = listBorneCommands(db, borneId).find((c) => c.id === target.id);
    assert.equal(updated.status, 'done');
  });

  it('POST /api/sync/borne/commands/:id/result retourne 404 pour une commande d\'une autre borne', async () => {
    const db = getDb();
    const otherId = 'borne-sync-other';
    const rawOther = randomBytes(32).toString('hex');
    insertBorne(db, {
      id: otherId, name: 'Autre borne',
      token_hash: createHash('sha256').update(rawOther).digest('hex'), token_clear: rawOther,
    });
    const otherCmd = insertBorneCommand(db, { borne_id: otherId, type: 'pull' });

    const res = await request.post(`/api/sync/borne/commands/${otherCmd.lastInsertRowid}/result`)
      .set('X-Box-Token', borneToken)
      .send({ status: 'done' });
    assert.equal(res.status, 404);
  });

  it('POST /api/sync/borne/commands/:id/result retourne 400 pour un status invalide', async () => {
    const db = getDb();
    const cmd = insertBorneCommand(db, { borne_id: borneId, type: 'close_event' });
    const res = await request.post(`/api/sync/borne/commands/${cmd.lastInsertRowid}/result`)
      .set('X-Box-Token', borneToken)
      .send({ status: 'bogus' });
    assert.equal(res.status, 400);
  });
});
