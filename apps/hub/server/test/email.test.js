import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, getUserByEmail, listEmailLogs } from '../src/registry.js';
import { createNullMailer } from '../src/email/mailer.js';
import { renderTemplate, renderString } from '../src/email/render.js';
import { maskEmail } from '../src/email/url.js';

// ── Unitaires : render + null mailer ─────────────────────────────────────────

describe('email/render', () => {
  it('substitue les variables {{var}}', () => {
    assert.equal(renderString('Bonjour {{name}} !', { name: 'Marie' }), 'Bonjour Marie !');
  });

  it('remplace une variable absente par une chaîne vide (jamais de {{…}} brut)', () => {
    assert.equal(renderString('X{{absent}}Y', {}), 'XY');
  });

  it('extrait le sujet (1re ligne Subject:) et le corps du template registration', () => {
    const { subject, text } = renderTemplate('registration', { name: ' Marie', url: 'https://x/y' });
    assert.match(subject, /compte Kapsule/i);
    assert.ok(text.includes('https://x/y'));
    assert.ok(!text.includes('Subject:'));
  });
});

describe('email/mailer (null)', () => {
  it('le null mailer ne fait rien et retourne { ok:false, skipped:true }', async () => {
    const m = createNullMailer();
    const r = await m.sendRegistrationLink({ to: 'a@b.c', name: 'X', url: 'http://x' });
    assert.deepEqual(r, { ok: false, skipped: true });
  });
});

// ── Route : POST /api/admin/users/:id/send-registration ──────────────────────

describe('POST /api/admin/users/:id/send-registration', () => {
  let dir, request, tokenAdmin, tokenClient, targetId;
  const sent = []; // capture les envois du mailer mock

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-email-'));
    // Mailer mock injecté via le 3e arg de createApp : aucun SMTP réel touché.
    const mailer = {
      sendRegistrationLink: async (opts) => { sent.push(opts); return { ok: true, subject: 'Activez votre compte Kapsule' }; },
      sendPasswordReset: async () => ({ ok: true }),
    };
    const app = createApp(dir, {}, { mailer });
    request = supertest(app);

    const db = getDb();
    const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
    const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
    insertUser(db, { email: 'admin@e.test',  password_hash: hashAdmin,  role: 'superuser' });
    insertUser(db, { email: 'client@e.test', password_hash: hashClient, role: 'client' });
    const target = insertUser(db, { email: 'target@e.test', name: 'Cible', role: 'client' });
    targetId = target.lastInsertRowid;

    const r1 = await request.post('/api/auth/login').send({ email: 'admin@e.test',  password: 'admin-pass' });
    const r2 = await request.post('/api/auth/login').send({ email: 'client@e.test', password: 'client-pass' });
    tokenAdmin  = r1.body.token;
    tokenClient = r2.body.token;
  });

  after(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('envoie le mail, journalise sent, retourne url + email_sent:true', async () => {
    const res = await request.post(`/api/admin/users/${targetId}/send-registration`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, true);
    assert.ok(res.body.registration_url.includes('/register?token='));
    // mailer mock appelé avec la bonne adresse
    assert.equal(sent.at(-1).to, 'target@e.test');
    // journalisé en 'sent'
    const logs = listEmailLogs(getDb(), { limit: 10 });
    assert.equal(logs[0].recipient_email, 'target@e.test');
    assert.equal(logs[0].status, 'sent');
  });

  it('retourne 404 pour un user inconnu', async () => {
    const res = await request.post('/api/admin/users/99999/send-registration')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client (réservé superuser)', async () => {
    const res = await request.post(`/api/admin/users/${targetId}/send-registration`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── Route : échec SMTP → 200 + email_sent:false + log failed ─────────────────

describe('send-registration — échec SMTP', () => {
  let dir, request, tokenAdmin, targetId;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-email-ko-'));
    const mailer = {
      sendRegistrationLink: async () => { throw new Error('SMTP down'); },
      sendPasswordReset: async () => ({ ok: true }),
    };
    const app = createApp(dir, {}, { mailer });
    request = supertest(app);

    const db = getDb();
    const hashAdmin = await argon2.hash('admin-pass', { type: argon2.argon2id });
    insertUser(db, { email: 'admin@ko.test', password_hash: hashAdmin, role: 'superuser' });
    const target = insertUser(db, { email: 'target@ko.test', role: 'client' });
    targetId = target.lastInsertRowid;
    const r1 = await request.post('/api/auth/login').send({ email: 'admin@ko.test', password: 'admin-pass' });
    tokenAdmin = r1.body.token;
  });

  after(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ne fait pas échouer la requête : 200 + email_sent:false + url fallback + log failed', async () => {
    const res = await request.post(`/api/admin/users/${targetId}/send-registration`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, false);
    assert.ok(res.body.registration_url.includes('/register?token='));
    const logs = listEmailLogs(getDb(), { limit: 10 });
    assert.equal(logs[0].status, 'failed');
    assert.match(logs[0].error, /SMTP down/);
  });
});

// ── Route : SMTP désactivé (null mailer par défaut) → log 'skipped' ──────────

describe('send-registration — SMTP désactivé (null mailer)', () => {
  let dir, request, tokenAdmin, targetId;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-email-skip-'));
    // Aucun mailer injecté → createApp utilise createNullMailer() (no-op).
    const app = createApp(dir);
    request = supertest(app);

    const db = getDb();
    const hashAdmin = await argon2.hash('admin-pass', { type: argon2.argon2id });
    insertUser(db, { email: 'admin@skip.test', password_hash: hashAdmin, role: 'superuser' });
    const target = insertUser(db, { email: 'target@skip.test', role: 'client' });
    targetId = target.lastInsertRowid;
    const r1 = await request.post('/api/auth/login').send({ email: 'admin@skip.test', password: 'admin-pass' });
    tokenAdmin = r1.body.token;
  });

  after(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('200 + email_sent:false + url fallback + log skipped', async () => {
    const res = await request.post(`/api/admin/users/${targetId}/send-registration`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, false);
    assert.ok(res.body.registration_url.includes('/register?token='));
    const logs = listEmailLogs(getDb(), { limit: 10 });
    assert.equal(logs[0].status, 'skipped');
    assert.equal(logs[0].error, null);
  });
});

// ── Route : POST /api/auth/forgot-password ───────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  let dir, request;
  const resets = []; // capture les envois password_reset du mailer mock

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-forgot-'));
    const mailer = {
      sendRegistrationLink: async () => ({ ok: true }),
      sendPasswordReset: async (opts) => { resets.push(opts); return { ok: true, subject: 'Réinitialisation' }; },
    };
    const app = createApp(dir, {}, { mailer });
    request = supertest(app);

    const db = getDb();
    const hash = await argon2.hash('pass', { type: argon2.argon2id });
    insertUser(db, { email: 'real@f.test', password_hash: hash, role: 'client' });
    insertUser(db, { email: 'inactive@f.test', password_hash: hash, role: 'client', active: 0 });
  });

  after(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('email existant : 200 générique + envoi + log sent', async () => {
    const res = await request.post('/api/auth/forgot-password').send({ email: 'real@f.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /spams/i);
    assert.equal(resets.at(-1).to, 'real@f.test');
    const logs = listEmailLogs(getDb(), { limit: 10 });
    assert.equal(logs[0].type, 'password_reset');
    assert.equal(logs[0].status, 'sent');
  });

  it('email inconnu : 200 même message, mailer NON appelé, aucun log ni token', async () => {
    const before = resets.length;
    const logsBefore = listEmailLogs(getDb(), { limit: 100 }).length;
    const res = await request.post('/api/auth/forgot-password').send({ email: 'ghost@f.test' });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /spams/i);
    assert.equal(resets.length, before, 'mailer ne doit pas être appelé pour un inconnu');
    assert.equal(listEmailLogs(getDb(), { limit: 100 }).length, logsBefore, 'aucun log ajouté');
  });

  it('compte inactif : 200 même message, mailer NON appelé', async () => {
    const before = resets.length;
    const res = await request.post('/api/auth/forgot-password').send({ email: 'inactive@f.test' });
    assert.equal(res.status, 200);
    assert.equal(resets.length, before);
  });

  it('renvoi < 5 min refusé : 200 générique mais pas de nouvel envoi', async () => {
    // real@f.test a déjà reçu un token au 1er test (< 5 min) → garde anti-spam
    const before = resets.length;
    const res = await request.post('/api/auth/forgot-password').send({ email: 'real@f.test' });
    assert.equal(res.status, 200);
    assert.equal(resets.length, before, 'pas de second envoi sous 5 min');
  });

  it('400 si email absent', async () => {
    const res = await request.post('/api/auth/forgot-password').send({});
    assert.equal(res.status, 400);
  });
});

// ── Route : GET /api/admin/email-logs ────────────────────────────────────────

describe('GET /api/admin/email-logs', () => {
  let dir, request, tokenAdmin, tokenClient;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-emaillogs-'));
    const app = createApp(dir);
    request = supertest(app);

    const db = getDb();
    const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
    const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
    insertUser(db, { email: 'admin@logs.test',  password_hash: hashAdmin,  role: 'superuser' });
    insertUser(db, { email: 'client@logs.test', password_hash: hashClient, role: 'client' });
    // Une entrée de log pour vérifier la sérialisation
    db.prepare("INSERT INTO email_logs (recipient_email, type, subject, status) VALUES ('x@logs.test', 'registration', 'Sujet', 'sent')").run();

    const r1 = await request.post('/api/auth/login').send({ email: 'admin@logs.test',  password: 'admin-pass' });
    const r2 = await request.post('/api/auth/login').send({ email: 'client@logs.test', password: 'client-pass' });
    tokenAdmin  = r1.body.token;
    tokenClient = r2.body.token;
  });

  after(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('200 + logs + diagnostic SMTP pour un superuser', async () => {
    const res = await request.get('/api/admin/email-logs')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.logs));
    assert.equal(res.body.logs[0].recipient_email, 'x@logs.test');
    assert.equal(res.body.logs[0].status, 'sent');
    // Diagnostic SMTP exposé : en test SMTP_HOST est vide → configured:false,
    // et aucun secret SMTP (user/password) ne doit fuiter.
    assert.equal(res.body.smtp.configured, false);
    assert.ok(!('password' in res.body.smtp));
    assert.ok(!('user' in res.body.smtp));
  });

  it('403 pour un client', async () => {
    const res = await request.get('/api/admin/email-logs')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

describe('email/maskEmail', () => {
  it('masque le local-part et conserve le domaine', () => {
    assert.equal(maskEmail('marie.dupont@exemple.fr'), 'ma***@exemple.fr');
    assert.equal(maskEmail('a@b.fr'), 'a***@b.fr');
  });

  it('ne laisse jamais fuiter l\'adresse complète', () => {
    const email = 'confidentiel@exemple.fr';
    assert.ok(!maskEmail(email).includes('confidentiel'));
  });

  it('retourne ? sur une entrée absente ou non-email', () => {
    assert.equal(maskEmail(undefined), '?');
    assert.equal(maskEmail(null), '?');
    assert.equal(maskEmail('pas-un-email'), '?');
    assert.equal(maskEmail(123), '?');
  });
});
