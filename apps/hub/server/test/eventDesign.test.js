import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import {
  getDb, closeRegistry, insertUser, updateEvent, insertBoxToken,
} from '../src/registry.js';
import { openEventDb, closeAllEventDbs } from '../src/eventStore.js';
import { randomBytes, createHash } from 'node:crypto';

// Application d'un design à un événement (§9bis) : copie snapshot, jamais référence.

let dir;
let request;
let tokenAlice; // superuser
let tokenBob;   // client (non membre des événements d'alice)

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-evdesign-'));
  request = supertest(createApp(dir));

  const db = getDb();
  const hashA = await argon2.hash('pass-alice', { type: argon2.argon2id });
  const hashB = await argon2.hash('pass-bob', { type: argon2.argon2id });
  insertUser(db, { email: 'alice@ed.test', password_hash: hashA, role: 'superuser' });
  insertUser(db, { email: 'bob@ed.test', password_hash: hashB, role: 'client' });

  tokenAlice = (await request.post('/api/auth/login').send({ email: 'alice@ed.test', password: 'pass-alice' })).body.token;
  tokenBob = (await request.post('/api/auth/login').send({ email: 'bob@ed.test', password: 'pass-bob' })).body.token;
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createEvent(name = 'Événement design') {
  const res = await request.post('/api/events').set(auth(tokenAlice)).send({ name });
  assert.equal(res.status, 201, `création événement : ${JSON.stringify(res.body)}`);
  return res.body.id;
}

// Design appartenant à alice, avec un logo téléversé.
async function createDesignWithLogo(name = 'Design avec logo') {
  const design = (await request.post('/api/designs').set(auth(tokenAlice)).send({ name })).body;
  const up = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
    .set(auth(tokenAlice))
    .attach('file', PNG_1x1, { filename: 'logo.png', contentType: 'image/png' });
  assert.equal(up.status, 201);
  return { id: design.id, filename: up.body.filename };
}

const readMeta = (eventId, key) =>
  openEventDb(eventId, dir).prepare('SELECT value FROM event_meta WHERE key=?').get(key)?.value ?? null;

// ── PUT /api/events/:eventId/design ───────────────────────────────────────────

describe('PUT /api/events/:eventId/design', () => {
  it('copie la config ET les fichiers dans l\'événement (snapshot)', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();

    const res = await request.put(`/api/events/${eventId}/design`)
      .set(auth(tokenAlice))
      .send({ design_id: design.id });

    assert.equal(res.status, 200);

    // La config est écrite dans event_meta, sérialisée.
    const meta = JSON.parse(readMeta(eventId, 'design'));
    assert.equal(meta.version, 1);
    assert.equal(meta.assets.logo, design.filename);

    // Le fichier est COPIÉ dans le dossier de l'événement.
    assert.ok(existsSync(join(dir, 'events', eventId, 'design', design.filename)));
  });

  it('screenOverrides survit intact dans la copie snapshot (design3)', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    const screenOverrides = {
      start: { colors: { text: '#0000ff' } },
      recording: { colors: { primary: '#ff0000' } },
    };
    const full = (await request.get(`/api/designs/${design.id}`).set(auth(tokenAlice))).body;
    await request.put(`/api/designs/${design.id}`).set(auth(tokenAlice))
      .send({ config: { ...full.config, screenOverrides } });

    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    const meta = JSON.parse(readMeta(eventId, 'design'));
    assert.deepEqual(meta.screenOverrides, screenOverrides);
  });

  it('snapshot, pas référence : modifier le design source n\'affecte pas un événement non-preview (§11.26)', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();

    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    updateEvent(getDb(), eventId, { status: 'ready' }); // hors preview : ne doit JAMAIS être rafraîchi (design2, §9bis)
    const before_ = JSON.parse(readMeta(eventId, 'design'));

    // On modifie le design dans la bibliothèque…
    const full = (await request.get(`/api/designs/${design.id}`).set(auth(tokenAlice))).body;
    await request.put(`/api/designs/${design.id}`).set(auth(tokenAlice))
      .send({ config: { ...full.config, colors: { ...full.config.colors, bg: '#123456' } } });

    // …l'événement garde sa copie.
    const after_ = JSON.parse(readMeta(eventId, 'design'));
    assert.deepEqual(after_, before_);
    assert.notEqual(after_.colors.bg, '#123456');
  });

  it('supprimer le design source ne casse pas l\'événement', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();

    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    await request.delete(`/api/designs/${design.id}`).set(auth(tokenAlice));

    // La config et le fichier de l'événement survivent.
    assert.ok(readMeta(eventId, 'design'));
    assert.ok(existsSync(join(dir, 'events', eventId, 'design', design.filename)));
  });

  it('remplacer le design vide les anciens fichiers', async () => {
    const eventId = await createEvent();
    const first = await createDesignWithLogo('Premier');
    const second = await createDesignWithLogo('Second');

    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: first.id });
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: second.id });

    const files = readdirSync(join(dir, 'events', eventId, 'design'));
    assert.deepEqual(files, [second.filename], 'seul l\'asset du design courant subsiste');
  });

  it('409 si l\'événement est gelé', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    updateEvent(getDb(), eventId, { status: 'ready' }); // contenu gelé

    const res = await request.put(`/api/events/${eventId}/design`)
      .set(auth(tokenAlice))
      .send({ design_id: design.id });

    assert.equal(res.status, 409);
  });

  it('un design source aux images manquantes → 409 SANS détruire le design déjà appliqué', async () => {
    const eventId = await createEvent();
    const applied = await createDesignWithLogo('Design correct');
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: applied.id });

    // Un design dont la config référence une image, mais dont le fichier n'existe pas.
    const broken = (await request.post('/api/designs').set(auth(tokenAlice)).send({ name: 'Design cassé' })).body;
    const full = (await request.get(`/api/designs/${broken.id}`).set(auth(tokenAlice))).body;
    await request.put(`/api/designs/${broken.id}`).set(auth(tokenAlice))
      .send({ config: { ...full.config, assets: { logo: '00000000-0000-4000-8000-000000000000.png', background: null } } });

    const res = await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: broken.id });
    assert.equal(res.status, 409);

    // Le design précédemment appliqué (config + fichier) doit être intact.
    const meta = JSON.parse(readMeta(eventId, 'design'));
    assert.equal(meta.assets.logo, applied.filename);
    assert.ok(existsSync(join(dir, 'events', eventId, 'design', applied.filename)));
  });

  it('400 sans design_id, 404 si le design est inconnu', async () => {
    const eventId = await createEvent();

    const noBody = await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({});
    assert.equal(noBody.status, 400);

    const unknown = await request.put(`/api/events/${eventId}/design`)
      .set(auth(tokenAlice))
      .send({ design_id: 'inexistant' });
    assert.equal(unknown.status, 404);
  });

  it('403 si l\'utilisateur n\'est pas membre de l\'événement', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();

    const res = await request.put(`/api/events/${eventId}/design`)
      .set(auth(tokenBob))
      .send({ design_id: design.id });

    assert.equal(res.status, 403);
  });
});

// ── DELETE /api/events/:eventId/design ────────────────────────────────────────

describe('DELETE /api/events/:eventId/design', () => {
  it('retire la clé et vide le dossier (retour aux thèmes)', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    const res = await request.delete(`/api/events/${eventId}/design`).set(auth(tokenAlice));
    assert.equal(res.status, 200);

    assert.equal(readMeta(eventId, 'design'), null);
    assert.ok(!existsSync(join(dir, 'events', eventId, 'design', design.filename)));
  });

  it('409 si l\'événement est gelé', async () => {
    const eventId = await createEvent();
    updateEvent(getDb(), eventId, { status: 'live' });

    const res = await request.delete(`/api/events/${eventId}/design`).set(auth(tokenAlice));
    assert.equal(res.status, 409);
  });
});

// ── restore : l'historique de version restaure aussi le design (§9bis) ────────

describe('restauration de version et design', () => {
  it('restaurer une version antérieure au design retire le design', async () => {
    const eventId = await createEvent();
    // v1 : sans design (juste la création). On force une première version en
    // éditant une meta anodine.
    await request.put(`/api/events/${eventId}`).set(auth(tokenAlice)).send({ idle_timeout: 100 });
    const versionsBefore = (await request.get(`/api/events/${eventId}/versions`).set(auth(tokenAlice))).body;
    const noDesignVersion = versionsBefore[0].id;

    // Applique un design (nouvelle version capturée).
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    assert.ok(readMeta(eventId, 'design'), 'le design est appliqué');

    // Restaure la version d'avant le design.
    const res = await request.post(`/api/events/${eventId}/versions/${noDesignVersion}/restore`).set(auth(tokenAlice));
    assert.equal(res.status, 200);

    // Le design doit avoir disparu (clé + dossier).
    assert.equal(readMeta(eventId, 'design'), null);
    assert.ok(!existsSync(join(dir, 'events', eventId, 'design', design.filename)));
  });

  it('restaurer une version AVEC design le réapplique', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    const withDesign = (await request.get(`/api/events/${eventId}/versions`).set(auth(tokenAlice))).body[0].id;

    // Retire le design (nouvelle version sans design).
    await request.delete(`/api/events/${eventId}/design`).set(auth(tokenAlice));
    assert.equal(readMeta(eventId, 'design'), null);

    // Restaure la version qui portait le design.
    const res = await request.post(`/api/events/${eventId}/versions/${withDesign}/restore`).set(auth(tokenAlice));
    assert.equal(res.status, 200);

    const meta = JSON.parse(readMeta(eventId, 'design'));
    assert.equal(meta.assets.logo, design.filename);
    // Le fichier est toujours là (le retrait n'a fait que vider… il faut donc que
    // le restore le retrouve : ici il a été supprimé par le DELETE, on accepte la
    // config dégradée sans image — cf. limite documentée).
  });
});

// ── push-config : le design ne remonte JAMAIS de la borne vers le Hub ─────────

describe('sens unique Hub → Borne', () => {
  it('un push-config de la borne ne peut ni écraser ni effacer event_meta.design', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    const applied = readMeta(eventId, 'design');

    // La borne pousse sa config (mode overwrite), en tentant d'injecter un design.
    const db = getDb();
    const { randomBytes, createHash } = await import('node:crypto');
    const token = randomBytes(16).toString('hex');
    db.prepare(
      'INSERT INTO box_tokens (event_id, token_hash, token_clear, label) VALUES (?, ?, ?, ?)',
    ).run(eventId, createHash('sha256').update(token).digest('hex'), token, 'test');

    const res = await request.post(`/api/sync/events/${eventId}/config`)
      .set('X-Box-Token', token)
      .send({
        mode: 'overwrite',
        questions: [],
        meta: { theme: 'dark', design: JSON.stringify({ version: 1, colors: { bg: '#000000' } }) },
      });

    assert.equal(res.status, 200);

    // 'design' n'est pas dans META_KEYS : applyEventConfig itère sur la whitelist,
    // donc la clé du payload est ignorée — le design appliqué reste intact.
    assert.equal(readMeta(eventId, 'design'), applied);
  });
});

// ── design2 : provenance + rafraîchissement de la borne d'essai ──────────────

describe('PUT /api/events/:eventId/design — provenance', () => {
  it('écrit design_source_id et la ref registre event_design_refs', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();

    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    assert.equal(readMeta(eventId, 'design_source_id'), design.id);
    const ref = getDb().prepare('SELECT * FROM event_design_refs WHERE event_id = ?').get(eventId);
    assert.equal(ref.design_id, design.id);
  });

  it('DELETE design event retire design_source_id et la ref', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    const res = await request.delete(`/api/events/${eventId}/design`).set(auth(tokenAlice));
    assert.equal(res.status, 200);

    assert.equal(readMeta(eventId, 'design_source_id'), null);
    const ref = getDb().prepare('SELECT * FROM event_design_refs WHERE event_id = ?').get(eventId);
    assert.equal(ref, undefined);
  });

  it('supprimer l\'événement purge la ref (ON DELETE CASCADE)', async () => {
    const eventName = 'Événement design à purger';
    const eventId = await createEvent(eventName);
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    const del = await request.delete(`/api/events/${eventId}`).set(auth(tokenAlice)).send({ confirm: eventName });
    assert.equal(del.status, 200);

    const ref = getDb().prepare('SELECT * FROM event_design_refs WHERE event_id = ?').get(eventId);
    assert.equal(ref, undefined);
  });
});

describe('PUT /api/designs/:id — rafraîchissement de la borne d\'essai (design2)', () => {
  it('éditer le design rafraîchit un événement preview mais PAS un événement ready — §11.26', async () => {
    const previewEventId = await createEvent('Preview vivant');
    const readyEventId = await createEvent('Ready figé');
    const design = await createDesignWithLogo();

    await request.put(`/api/events/${previewEventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    await request.put(`/api/events/${readyEventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    updateEvent(getDb(), readyEventId, { status: 'ready' });

    const readyBefore = JSON.parse(readMeta(readyEventId, 'design'));

    // Édite le design source (couleur bg).
    const full = (await request.get(`/api/designs/${design.id}`).set(auth(tokenAlice))).body;
    const res = await request.put(`/api/designs/${design.id}`).set(auth(tokenAlice))
      .send({ config: { ...full.config, colors: { ...full.config.colors, bg: '#abcdef' } } });
    assert.equal(res.status, 200);

    // L'événement preview reflète la nouvelle couleur.
    const previewAfter = JSON.parse(readMeta(previewEventId, 'design'));
    assert.equal(previewAfter.colors.bg, '#abcdef');

    // L'événement ready n'a PAS bougé (invariant §11.26 — copie figée).
    const readyAfter = JSON.parse(readMeta(readyEventId, 'design'));
    assert.deepEqual(readyAfter, readyBefore);
    assert.notEqual(readyAfter.colors.bg, '#abcdef');
  });

  it('un événement preview détaché (design supprimé) n\'est plus rafraîchi', async () => {
    const eventId = await createEvent();
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });

    await request.delete(`/api/designs/${design.id}`).set(auth(tokenAlice));

    // La copie figée survit (déjà couvert par un autre test) ; ici on vérifie
    // juste que la ref a disparu — rien à rafraîchir pour cet event désormais.
    const ref = getDb().prepare('SELECT * FROM event_design_refs WHERE event_id = ?').get(eventId);
    assert.equal(ref, undefined);
  });
});

describe('design_source_id reste Hub-only (bundle de pull)', () => {
  it('le bundle GET /api/sync/events/:id/bundle n\'expose jamais design_source_id', async () => {
    const eventId = await createEvent('Preview bundle');
    const design = await createDesignWithLogo();
    await request.put(`/api/events/${eventId}/design`).set(auth(tokenAlice)).send({ design_id: design.id });
    assert.ok(readMeta(eventId, 'design_source_id'), 'précondition : la trace de provenance existe côté Hub');

    const raw = randomBytes(16).toString('hex');
    insertBoxToken(getDb(), {
      event_id: eventId,
      token_hash: createHash('sha256').update(raw).digest('hex'),
      token_clear: raw,
      label: 'preview',
      is_preview: 1,
    });

    const res = await request.get(`/api/sync/events/${eventId}/bundle`).set('X-Box-Token', raw);
    assert.equal(res.status, 200);
    assert.equal(res.body.event.meta.design_source_id, undefined);
    assert.ok(res.body.event.meta.design, 'la config du design copiée doit, elle, être présente');
  });
});
