import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

let dir;
let request;
let tokenAlice; // superuser
let tokenBob;   // client
let tokenCarol; // autre client — vérifie le cloisonnement entre clients

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-designs-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashA = await argon2.hash('pass-alice', { type: argon2.argon2id });
  const hashB = await argon2.hash('pass-bob', { type: argon2.argon2id });
  const hashC = await argon2.hash('pass-carol', { type: argon2.argon2id });
  insertUser(db, { email: 'alice@dz.test', password_hash: hashA, role: 'superuser' });
  insertUser(db, { email: 'bob@dz.test', password_hash: hashB, role: 'client' });
  insertUser(db, { email: 'carol@dz.test', password_hash: hashC, role: 'client' });

  const loginA = await request.post('/api/auth/login').send({ email: 'alice@dz.test', password: 'pass-alice' });
  const loginB = await request.post('/api/auth/login').send({ email: 'bob@dz.test', password: 'pass-bob' });
  const loginC = await request.post('/api/auth/login').send({ email: 'carol@dz.test', password: 'pass-carol' });
  tokenAlice = loginA.body.token;
  tokenBob = loginB.body.token;
  tokenCarol = loginC.body.token;
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Crée un design appartenant au porteur du token, retourne le corps de la réponse.
async function createDesign(token, name = 'Mon design', config) {
  const body = config === undefined ? { name } : { name, config };
  const res = await request.post('/api/designs').set(auth(token)).send(body);
  assert.equal(res.status, 201, `création échouée : ${JSON.stringify(res.body)}`);
  return res.body;
}

// ── seed des templates ────────────────────────────────────────────────────────

describe('seed des templates', () => {
  it('les 3 templates sont visibles par un client', async () => {
    const res = await request.get('/api/designs').set(auth(tokenBob));
    assert.equal(res.status, 200);
    const templates = res.body.filter((d) => d.is_template === 1);
    assert.equal(templates.length, 3);
    assert.deepEqual(
      templates.map((d) => d.name).sort(),
      ['Cutealism', 'Moderne', 'Sombre'],
    );
    // Les templates n'appartiennent à personne.
    for (const t of templates) assert.equal(t.owner_id, null);
  });

  it('les templates portent une config valide et complète', async () => {
    const res = await request.get('/api/designs').set(auth(tokenBob));
    const cute = res.body.find((d) => d.name === 'Cutealism');
    assert.equal(cute.config.version, 1);
    // Valeurs réelles transcrites depuis app.css — pas de valeurs inventées.
    assert.equal(cute.config.colors.bg, '#FFF8EE');
    assert.equal(cute.config.colors.accent, '#F27405');
    assert.equal(Object.keys(cute.config.colors).length, 18);
    assert.equal(cute.config.radius, 'soft');
    assert.deepEqual(cute.config.assets, { logo: null, background: null });
  });
});

// ── GET /api/designs ──────────────────────────────────────────────────────────

describe('GET /api/designs', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get('/api/designs');
    assert.equal(res.status, 401);
  });

  it('un client ne voit pas les designs privés d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Design privé de Carol');

    const res = await request.get('/api/designs').set(auth(tokenBob));
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((d) => d.id === secret.id), 'bob ne doit pas voir le design de carol');
  });

  it('un superuser voit tous les designs, y compris les privés', async () => {
    const secret = await createDesign(tokenCarol, 'Autre privé de Carol');

    const res = await request.get('/api/designs').set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.ok(res.body.some((d) => d.id === secret.id), 'alice (superuser) doit tout voir');
  });

  it('expose owner_email au superuser (groupement par propriétaire)', async () => {
    const design = await createDesign(tokenCarol, 'Design avec owner_email');

    const res = await request.get('/api/designs').set(auth(tokenAlice));
    const found = res.body.find((d) => d.id === design.id);
    assert.equal(found.owner_email, 'carol@dz.test');

    // Les templates seed n'ont pas de propriétaire.
    const template = res.body.find((d) => d.is_template === 1 && d.owner_id === null);
    assert.equal(template.owner_email, null);
  });

  it('n\'expose JAMAIS owner_email à un client (fuite inter-clients via un template promu)', async () => {
    // Un design promu garde son owner_id : il devient lisible par tous les clients.
    // Sans filtrage, l'email de son propriétaire d'origine fuiterait à chacun d'eux.
    const design = await createDesign(tokenCarol, 'Design de Carol promu');
    await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});

    const res = await request.get('/api/designs').set(auth(tokenBob));
    const promoted = res.body.find((d) => d.id === design.id);
    assert.ok(promoted, 'bob doit voir le template promu');
    assert.equal(promoted.owner_email, undefined, 'l\'email de carol ne doit pas fuiter vers bob');

    // Aucun design de la réponse client ne porte d'email.
    for (const d of res.body) assert.equal(d.owner_email, undefined);
  });
});

// ── POST /api/designs ─────────────────────────────────────────────────────────

describe('POST /api/designs', () => {
  it('crée un design et une version initiale', async () => {
    const design = await createDesign(tokenBob, 'Mariage Léa & Hugo');
    assert.equal(design.name, 'Mariage Léa & Hugo');
    assert.equal(design.is_template, 0);
    assert.equal(design.config.version, 1);

    const versions = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    assert.equal(versions.status, 200);
    assert.equal(versions.body.length, 1, 'une version initiale doit exister');
    assert.equal(versions.body[0].author, 'bob@dz.test');
  });

  it('sans config, reprend la config par défaut (Cutealism)', async () => {
    const design = await createDesign(tokenBob, 'Depuis défaut');
    assert.equal(design.config.colors.bg, '#FFF8EE');
  });

  it('la création par défaut survit au renommage du template Cutealism', async () => {
    // Le défaut vient d'une constante, pas d'un SELECT ... WHERE name = 'Cutealism' :
    // un superuser qui renomme le template ne doit pas casser POST /api/designs.
    const list = await request.get('/api/designs').set(auth(tokenAlice));
    const cute = list.body.find((d) => d.name === 'Cutealism');
    await request.put(`/api/designs/${cute.id}`).set(auth(tokenAlice)).send({ name: 'Cutealism renommé' });

    const design = await createDesign(tokenBob, 'Après renommage');
    assert.equal(design.config.colors.bg, '#FFF8EE');

    await request.put(`/api/designs/${cute.id}`).set(auth(tokenAlice)).send({ name: 'Cutealism' }); // restaure
  });

  it('refuse un nom vide (400)', async () => {
    const res = await request.post('/api/designs').set(auth(tokenBob)).send({ name: '  ' });
    assert.equal(res.status, 400);
  });

  it('refuse une config invalide (400)', async () => {
    const cases = [
      { label: 'clé couleur inconnue', config: { version: 1, colors: { 'evil-key': '#ffffff' } } },
      { label: 'hex malformé', config: { version: 1, colors: { bg: '#fff' } } },
      { label: 'valeur CSS libre', config: { version: 1, colors: { bg: 'url(https://evil.test/x)' } } },
      { label: 'layout hors enum', config: { version: 1, layouts: { start: 'diagonal' } } },
      { label: 'radius hors enum', config: { version: 1, radius: 'enorme' } },
      { label: 'asset SVG', config: { version: 1, assets: { logo: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.svg' } } },
      { label: 'version absente', config: { colors: { bg: '#ffffff' } } },
      { label: 'clé racine inconnue', config: { version: 1, style: 'position:fixed' } },
      { label: 'custom property injectée', config: { version: 1, '--evil': 'url(x)' } },
      { label: 'JSON > 16 Ko', config: { version: 1, assets: { logo: 'x'.repeat(17000) } } },
    ];
    for (const { label, config } of cases) {
      const res = await request.post('/api/designs').set(auth(tokenBob)).send({ name: label, config });
      assert.equal(res.status, 400, `${label} : attendu 400, reçu ${res.status}`);
      assert.ok(res.body.error, `${label} : message d'erreur attendu`);
    }
  });
});

// ── GET /api/designs/:id ──────────────────────────────────────────────────────

describe('GET /api/designs/:id', () => {
  it('404 si inconnu', async () => {
    const res = await request.get('/api/designs/inexistant').set(auth(tokenBob));
    assert.equal(res.status, 404);
  });

  it('403 sur le design privé d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Privé Carol GET');
    const res = await request.get(`/api/designs/${secret.id}`).set(auth(tokenBob));
    assert.equal(res.status, 403);
  });

  it('un client lit un template', async () => {
    const list = await request.get('/api/designs').set(auth(tokenBob));
    const template = list.body.find((d) => d.is_template === 1);
    const res = await request.get(`/api/designs/${template.id}`).set(auth(tokenBob));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, template.id);
  });

  it('un superuser lit le design privé d\'un client', async () => {
    const secret = await createDesign(tokenCarol, 'Privé Carol vu par alice');
    const res = await request.get(`/api/designs/${secret.id}`).set(auth(tokenAlice));
    assert.equal(res.status, 200);
  });
});

// ── PUT /api/designs/:id ──────────────────────────────────────────────────────

describe('PUT /api/designs/:id', () => {
  it('met à jour et versionne à chaque sauvegarde', async () => {
    const design = await createDesign(tokenBob, 'À éditer');

    const put1 = await request.put(`/api/designs/${design.id}`).set(auth(tokenBob))
      .send({ config: { ...design.config, colors: { ...design.config.colors, bg: '#000000' } } });
    assert.equal(put1.status, 200);
    assert.equal(put1.body.config.colors.bg, '#000000');

    const put2 = await request.put(`/api/designs/${design.id}`).set(auth(tokenBob))
      .send({ name: 'Renommé' });
    assert.equal(put2.status, 200);
    assert.equal(put2.body.name, 'Renommé');

    // 1 version initiale + 2 sauvegardes
    const versions = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    assert.equal(versions.body.length, 3);
  });

  it('refuse une config invalide (400)', async () => {
    const design = await createDesign(tokenBob, 'Config invalide au PUT');
    const res = await request.put(`/api/designs/${design.id}`).set(auth(tokenBob))
      .send({ config: { version: 1, colors: { bg: 'red' } } });
    assert.equal(res.status, 400);
  });

  it('403 sur le design d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Privé Carol PUT');
    const res = await request.put(`/api/designs/${secret.id}`).set(auth(tokenBob)).send({ name: 'pirate' });
    assert.equal(res.status, 403);
  });

  it('un client ne peut PAS modifier un template (403)', async () => {
    const list = await request.get('/api/designs').set(auth(tokenBob));
    const template = list.body.find((d) => d.is_template === 1);
    const res = await request.put(`/api/designs/${template.id}`).set(auth(tokenBob)).send({ name: 'détourné' });
    assert.equal(res.status, 403);
  });

  it('un superuser peut modifier un template', async () => {
    const list = await request.get('/api/designs').set(auth(tokenAlice));
    const template = list.body.find((d) => d.name === 'Moderne');
    const res = await request.put(`/api/designs/${template.id}`).set(auth(tokenAlice))
      .send({ name: 'Moderne' }); // même nom : on vérifie l'autorisation, pas le renommage
    assert.equal(res.status, 200);
  });
});

// ── DELETE /api/designs/:id ───────────────────────────────────────────────────

describe('DELETE /api/designs/:id', () => {
  it('supprime le design, ses versions et son dossier d\'assets', async () => {
    const design = await createDesign(tokenBob, 'À supprimer');

    // Simule un asset déjà uploadé (design.E remplira ce dossier pour de vrai).
    const assetsDir = join(dir, 'designs', design.id);
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'logo.png'), 'fake');

    const res = await request.delete(`/api/designs/${design.id}`).set(auth(tokenBob));
    assert.equal(res.status, 200);

    const after = await request.get(`/api/designs/${design.id}`).set(auth(tokenBob));
    assert.equal(after.status, 404);
    assert.ok(!existsSync(assetsDir), 'le dossier d\'assets doit être supprimé');

    // ON DELETE CASCADE : plus aucune version orpheline.
    const db = getDb();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM design_versions WHERE design_id = ?').get(design.id);
    assert.equal(n, 0);
  });

  it('403 sur le design d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Privé Carol DELETE');
    const res = await request.delete(`/api/designs/${secret.id}`).set(auth(tokenBob));
    assert.equal(res.status, 403);
  });

  it('404 si inconnu', async () => {
    const res = await request.delete('/api/designs/inexistant').set(auth(tokenBob));
    assert.equal(res.status, 404);
  });

  it('409 sur un template d\'origine (le seed ne se rejoue pas → perte définitive)', async () => {
    // Le front masque le bouton, mais le backend doit refuser aussi : sans cette
    // garde, un superuser supprimerait un template livré, sans retour possible.
    const list = await request.get('/api/designs').set(auth(tokenAlice));
    const seed = list.body.find((d) => d.is_template === 1 && d.owner_id === null);
    const res = await request.delete(`/api/designs/${seed.id}`).set(auth(tokenAlice));
    assert.equal(res.status, 409);

    const still = await request.get(`/api/designs/${seed.id}`).set(auth(tokenAlice));
    assert.equal(still.status, 200, 'le template doit toujours exister');
  });

  it('un :id de path traversal ne touche jamais au disque (404)', async () => {
    // Le dossier ciblé par une traversée doit survivre intacte.
    const victim = join(dir, 'events');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'canary.txt'), 'ne doit pas être supprimé');

    for (const evil of ['..', '../events', '%2e%2e%2fevents', 'a/../../events']) {
      const res = await request.delete(`/api/designs/${encodeURIComponent(evil)}`).set(auth(tokenBob));
      assert.equal(res.status, 404, `${evil} : attendu 404`);
    }

    assert.ok(existsSync(join(victim, 'canary.txt')), 'aucun fichier hors designs/ ne doit être supprimé');
  });
});

// ── POST /api/designs/:id/duplicate ───────────────────────────────────────────

describe('POST /api/designs/:id/duplicate', () => {
  it('un client duplique un template : la copie lui appartient et n\'est pas template', async () => {
    const list = await request.get('/api/designs').set(auth(tokenBob));
    const template = list.body.find((d) => d.name === 'Sombre');

    const res = await request.post(`/api/designs/${template.id}/duplicate`).set(auth(tokenBob)).send({});
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Sombre (copie)');
    assert.equal(res.body.is_template, 0, 'une copie n\'hérite pas du statut template');
    assert.deepEqual(res.body.config, template.config);

    // La copie est modifiable par bob (contrairement au template d'origine).
    const put = await request.put(`/api/designs/${res.body.id}`).set(auth(tokenBob)).send({ name: 'Ma version' });
    assert.equal(put.status, 200);
  });

  it('copie les fichiers assets (la copie ne partage pas le dossier source)', async () => {
    const source = await createDesign(tokenBob, 'Avec assets');
    const srcDir = join(dir, 'designs', source.id);
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'image.png'), 'fake-bytes');

    const res = await request.post(`/api/designs/${source.id}/duplicate`).set(auth(tokenBob)).send({});
    assert.equal(res.status, 201);
    assert.ok(existsSync(join(dir, 'designs', res.body.id, 'image.png')), 'l\'asset doit être copié');

    // Supprimer la source ne doit pas casser la copie.
    await request.delete(`/api/designs/${source.id}`).set(auth(tokenBob));
    assert.ok(existsSync(join(dir, 'designs', res.body.id, 'image.png')));
  });

  it('403 sur le design privé d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Privé Carol DUP');
    const res = await request.post(`/api/designs/${secret.id}/duplicate`).set(auth(tokenBob)).send({});
    assert.equal(res.status, 403);
  });

  it('404 si inconnu', async () => {
    const res = await request.post('/api/designs/inexistant/duplicate').set(auth(tokenBob)).send({});
    assert.equal(res.status, 404);
  });
});

// ── POST /api/designs/:id/promote ─────────────────────────────────────────────

describe('POST /api/designs/:id/promote', () => {
  it('un superuser promeut un design en template', async () => {
    const design = await createDesign(tokenBob, 'À promouvoir');

    const res = await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.is_template, 1);

    // Devenu template : carol (autre client) le voit maintenant.
    const list = await request.get('/api/designs').set(auth(tokenCarol));
    assert.ok(list.body.some((d) => d.id === design.id));
  });

  it('403 pour un client (même sur son propre design)', async () => {
    const design = await createDesign(tokenBob, 'Promotion interdite');
    const res = await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenBob)).send({});
    assert.equal(res.status, 403);
  });

  it('409 si le design est déjà un template (pas de no-op silencieux)', async () => {
    const design = await createDesign(tokenBob, 'Double promotion');
    await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});

    const res = await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});
    assert.equal(res.status, 409);
  });

  it('404 si inconnu', async () => {
    const res = await request.post('/api/designs/inexistant/promote').set(auth(tokenAlice)).send({});
    assert.equal(res.status, 404);
  });
});

// ── POST /api/designs/:id/demote ──────────────────────────────────────────────

describe('POST /api/designs/:id/demote', () => {
  it('un superuser retire le statut de template (retour au privé)', async () => {
    const design = await createDesign(tokenBob, 'Promu puis rétrogradé');
    await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});

    const res = await request.post(`/api/designs/${design.id}/demote`).set(auth(tokenAlice)).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.is_template, 0);

    // Redevenu privé : carol (autre client) ne le voit plus.
    const list = await request.get('/api/designs').set(auth(tokenCarol));
    assert.ok(!list.body.some((d) => d.id === design.id));
  });

  it('409 sur un template d\'origine (sans propriétaire, il deviendrait invisible)', async () => {
    const list = await request.get('/api/designs').set(auth(tokenAlice));
    const seed = list.body.find((d) => d.name === 'Cutealism');
    const res = await request.post(`/api/designs/${seed.id}/demote`).set(auth(tokenAlice)).send({});
    assert.equal(res.status, 409);
  });

  it('403 pour un client', async () => {
    const design = await createDesign(tokenBob, 'Demote interdit');
    await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});
    const res = await request.post(`/api/designs/${design.id}/demote`).set(auth(tokenBob)).send({});
    assert.equal(res.status, 403);
  });

  it('409 si le design n\'est pas un template (pas de no-op silencieux)', async () => {
    const design = await createDesign(tokenBob, 'Jamais promu');
    const res = await request.post(`/api/designs/${design.id}/demote`).set(auth(tokenAlice)).send({});
    assert.equal(res.status, 409);
  });
});

// ── assets (images du design) ─────────────────────────────────────────────────

// PNG 1×1 valide (le plus petit fichier PNG légal).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('POST /api/designs/:id/assets', () => {
  it('téléverse un PNG, référence le fichier dans la config et versionne', async () => {
    const design = await createDesign(tokenBob, 'Avec logo');

    const res = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'logo.png', contentType: 'image/png' });

    assert.equal(res.status, 201);
    assert.match(res.body.filename, /^[0-9a-f-]{36}\.png$/);

    // Le fichier est écrit sous le nom généré, pas sous celui du client.
    assert.ok(existsSync(join(dir, 'designs', design.id, res.body.filename)));

    // La config référence l'image, et l'upload a créé une version.
    const after = await request.get(`/api/designs/${design.id}`).set(auth(tokenBob));
    assert.equal(after.body.config.assets.logo, res.body.filename);

    const versions = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    assert.equal(versions.body.length, 2); // création + upload
  });

  it('remplace l\'image d\'un slot et supprime l\'ancien fichier', async () => {
    const design = await createDesign(tokenBob, 'Remplacement de logo');

    const first = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'a.png', contentType: 'image/png' });

    const second = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'b.png', contentType: 'image/png' });

    assert.equal(second.status, 201);
    assert.ok(!existsSync(join(dir, 'designs', design.id, first.body.filename)), 'ancien fichier supprimé');
    assert.ok(existsSync(join(dir, 'designs', design.id, second.body.filename)));
  });

  it('refuse un SVG (invariant : jamais de vecteur, risque XSS)', async () => {
    const design = await createDesign(tokenBob, 'SVG refusé');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const res = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', svg, { filename: 'evil.svg', contentType: 'image/svg+xml' });

    assert.equal(res.status, 400);
  });

  it('refuse un fichier > 2 Mo (413)', async () => {
    const design = await createDesign(tokenBob, 'Trop gros');
    const big = Buffer.alloc(2 * 1024 * 1024 + 1024, 0);

    const res = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' });

    assert.equal(res.status, 413);
  });

  it('refuse un slot inconnu et ne laisse pas le fichier orphelin', async () => {
    const design = await createDesign(tokenBob, 'Slot invalide');

    const res = await request.post(`/api/designs/${design.id}/assets?slot=evil`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    assert.equal(res.status, 400);

    // Le fichier a été écrit par multer avant la validation du slot : il doit
    // avoir été nettoyé.
    const dirPath = join(dir, 'designs', design.id);
    const files = existsSync(dirPath) ? readdirSync(dirPath) : [];
    assert.equal(files.length, 0, 'aucun fichier orphelin ne doit rester');
  });

  it('403 sur le design d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Assets privés');
    const res = await request.post(`/api/designs/${secret.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    assert.equal(res.status, 403);
  });
});

describe('DELETE /api/designs/:id/assets/:slot', () => {
  it('retire l\'image du slot et supprime le fichier', async () => {
    const design = await createDesign(tokenBob, 'Retrait de logo');
    const up = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    const res = await request.delete(`/api/designs/${design.id}/assets/logo`).set(auth(tokenBob));
    assert.equal(res.status, 200);

    assert.ok(!existsSync(join(dir, 'designs', design.id, up.body.filename)));

    const after = await request.get(`/api/designs/${design.id}`).set(auth(tokenBob));
    assert.equal(after.body.config.assets.logo, null);
  });

  it('404 si le slot est vide, 400 si le slot est inconnu', async () => {
    const design = await createDesign(tokenBob, 'Retraits invalides');

    const empty = await request.delete(`/api/designs/${design.id}/assets/logo`).set(auth(tokenBob));
    assert.equal(empty.status, 404);

    const bad = await request.delete(`/api/designs/${design.id}/assets/evil`).set(auth(tokenBob));
    assert.equal(bad.status, 400);
  });
});

describe('GET /api/designs/:id/assets/:filename', () => {
  it('sert une image référencée par la config', async () => {
    const design = await createDesign(tokenBob, 'Service d\'image');
    const up = await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    const res = await request.get(`/api/designs/${design.id}/assets/${up.body.filename}`).set(auth(tokenBob));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, PNG_1x1);
  });

  it('404 sur un fichier non référencé, et sur une traversée de chemin', async () => {
    const design = await createDesign(tokenBob, 'Traversée');
    await request.post(`/api/designs/${design.id}/assets?slot=logo`)
      .set(auth(tokenBob))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    // Fichier réellement présent sur le disque mais absent de la config.
    writeFileSync(join(dir, 'designs', design.id, 'secret.png'), 'nope');
    const unreferenced = await request.get(`/api/designs/${design.id}/assets/secret.png`).set(auth(tokenBob));
    assert.equal(unreferenced.status, 404);

    for (const evil of ['..%2F..%2Fregistry.sqlite', '%2e%2e%2f%2e%2e%2fregistry.sqlite']) {
      const res = await request.get(`/api/designs/${design.id}/assets/${evil}`).set(auth(tokenBob));
      assert.ok(res.status === 404 || res.status === 400, `traversée refusée (${res.status})`);
    }
  });

  it('403 sur le design d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Image privée');
    const up = await request.post(`/api/designs/${secret.id}/assets?slot=logo`)
      .set(auth(tokenCarol))
      .attach('file', PNG_1x1, { filename: 'x.png', contentType: 'image/png' });

    const res = await request.get(`/api/designs/${secret.id}/assets/${up.body.filename}`).set(auth(tokenBob));
    assert.equal(res.status, 403);
  });
});

// ── versions & restore ────────────────────────────────────────────────────────

describe('versions et restauration', () => {
  it('GET /versions/:vid retourne le snapshot complet', async () => {
    const design = await createDesign(tokenBob, 'Snapshot');
    const versions = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    const vid = versions.body[0].id;

    const res = await request.get(`/api/designs/${design.id}/versions/${vid}`).set(auth(tokenBob));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.snapshot, design.config);
  });

  it('restore remet la config d\'une version antérieure sans perdre l\'état courant', async () => {
    const design = await createDesign(tokenBob, 'À restaurer');
    const originalBg = design.config.colors.bg;

    // Version initiale (v1) = état d'origine.
    const v1 = (await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob))).body[0].id;

    // On modifie : le fond devient noir.
    await request.put(`/api/designs/${design.id}`).set(auth(tokenBob))
      .send({ config: { ...design.config, colors: { ...design.config.colors, bg: '#000000' } } });

    // On restaure v1 → le fond redevient celui d'origine.
    const res = await request.post(`/api/designs/${design.id}/restore`).set(auth(tokenBob)).send({ version_id: v1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.config.colors.bg, originalBg);

    // Append-only : l'état écrasé (#000000) reste consultable dans l'historique.
    const versions = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    const snapshots = [];
    for (const v of versions.body) {
      const full = await request.get(`/api/designs/${design.id}/versions/${v.id}`).set(auth(tokenBob));
      snapshots.push(full.body.snapshot.colors.bg);
    }
    assert.ok(snapshots.includes('#000000'), 'la config écrasée doit rester dans l\'historique');
  });

  it('restore : 400 sans version_id, 404 si la version appartient à un autre design', async () => {
    const design = await createDesign(tokenBob, 'Restore invalide');
    const other = await createDesign(tokenBob, 'Autre design');
    const otherVid = (await request.get(`/api/designs/${other.id}/versions`).set(auth(tokenBob))).body[0].id;

    const noBody = await request.post(`/api/designs/${design.id}/restore`).set(auth(tokenBob)).send({});
    assert.equal(noBody.status, 400);

    const wrongVersion = await request.post(`/api/designs/${design.id}/restore`).set(auth(tokenBob))
      .send({ version_id: otherVid });
    assert.equal(wrongVersion.status, 404);
  });

  it('restore : version_id non scalaire → 400 (et non 500)', async () => {
    const design = await createDesign(tokenBob, 'Restore non scalaire');
    // better-sqlite3 lèverait sur un bind d'objet/tableau → la garde doit répondre 400.
    for (const version_id of [{}, [], null, 'abc', 1.5]) {
      const res = await request.post(`/api/designs/${design.id}/restore`).set(auth(tokenBob)).send({ version_id });
      assert.equal(res.status, 400, `version_id=${JSON.stringify(version_id)} : attendu 400`);
    }
  });

  it('l\'auteur des versions ne fuite pas vers les lecteurs d\'un template promu', async () => {
    // Même faille que owner_email, par l'historique : le template promu reste
    // lisible par tous les clients, et `author` est l'email du propriétaire.
    const design = await createDesign(tokenCarol, 'Historique de Carol promu');
    await request.post(`/api/designs/${design.id}/promote`).set(auth(tokenAlice)).send({});

    const list = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenBob));
    assert.equal(list.status, 200);
    for (const v of list.body) {
      assert.equal(v.author, null, 'l\'email de carol ne doit pas fuiter vers bob');
    }

    const detail = await request.get(`/api/designs/${design.id}/versions/${list.body[0].id}`).set(auth(tokenBob));
    assert.equal(detail.body.author, null);

    // Le propriétaire, lui, voit bien l'auteur.
    const own = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenCarol));
    assert.equal(own.body[0].author, 'carol@dz.test');

    // Le superuser aussi.
    const su = await request.get(`/api/designs/${design.id}/versions`).set(auth(tokenAlice));
    assert.equal(su.body[0].author, 'carol@dz.test');
  });

  it('403 : un client ne peut ni lire ni restaurer les versions d\'un autre client', async () => {
    const secret = await createDesign(tokenCarol, 'Versions privées');
    const vid = (await request.get(`/api/designs/${secret.id}/versions`).set(auth(tokenCarol))).body[0].id;

    const list = await request.get(`/api/designs/${secret.id}/versions`).set(auth(tokenBob));
    assert.equal(list.status, 403);

    const get = await request.get(`/api/designs/${secret.id}/versions/${vid}`).set(auth(tokenBob));
    assert.equal(get.status, 403);

    const restore = await request.post(`/api/designs/${secret.id}/restore`).set(auth(tokenBob)).send({ version_id: vid });
    assert.equal(restore.status, 403);
  });
});
