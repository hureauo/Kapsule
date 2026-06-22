import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEventDb, closeAllEventDbs } from '../src/eventStore.js';
import { META_KEYS, applyEventConfig } from '../src/eventConfig.js';

let dir;
let counter = 0;

function freshDb() {
  const id = `evt-cfg-${++counter}`;
  mkdirSync(join(dir, 'events', id), { recursive: true });
  return openEventDb(id, dir);
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'kapsule-eventcfg-')); });
after(() => { closeAllEventDbs(); rmSync(dir, { recursive: true, force: true }); });

describe('META_KEYS', () => {
  it('contient theme, idle_timeout et tous les TEXT_FIELDS', () => {
    assert.ok(META_KEYS.includes('theme'));
    assert.ok(META_KEYS.includes('idle_timeout'));
    assert.ok(META_KEYS.includes('welcome_title'));
    assert.ok(META_KEYS.includes('consent_text'));
  });
});

describe('applyEventConfig — mode overwrite', () => {
  it('insère des questions et des meta', () => {
    const edb = freshDb();
    applyEventConfig(edb, {
      mode: 'overwrite',
      meta: { theme: 'dark', idle_timeout: '120' },
      questions: [{ text: 'Q1', max_duration: 30, countdown: 5 }],
    });

    const rows = edb.prepare('SELECT key, value FROM event_meta').all();
    const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
    assert.equal(meta.theme, 'dark');
    assert.equal(meta.idle_timeout, '120');

    const qs = edb.prepare('SELECT text FROM questions ORDER BY order_index').all();
    assert.equal(qs.length, 1);
    assert.equal(qs[0].text, 'Q1');
  });

  it('remplace les questions existantes', () => {
    const edb = freshDb();
    // Insérer une question manuellement (plus de seed par défaut)
    edb.prepare('INSERT INTO questions (text, max_duration, countdown, order_index) VALUES (?, ?, ?, ?)').run('Q existante', 60, 3, 0);

    applyEventConfig(edb, {
      mode: 'overwrite',
      questions: [{ text: 'Nouvelle Q', max_duration: 60, countdown: 3 }],
    });

    const qs = edb.prepare('SELECT text FROM questions ORDER BY order_index').all();
    assert.equal(qs.length, 1);
    assert.equal(qs[0].text, 'Nouvelle Q');
  });

  it('écrase une meta déjà présente', () => {
    const edb = freshDb();
    applyEventConfig(edb, { mode: 'overwrite', meta: { welcome_title: 'v1' } });
    applyEventConfig(edb, { mode: 'overwrite', meta: { welcome_title: 'v2' } });

    const val = edb.prepare("SELECT value FROM event_meta WHERE key='welcome_title'").get().value;
    assert.equal(val, 'v2');
  });

  it('utilise les défauts max_duration=60 et countdown=3 si absents', () => {
    const edb = freshDb();
    applyEventConfig(edb, {
      mode: 'overwrite',
      questions: [{ text: 'Sans défaut' }],
    });
    const q = edb.prepare("SELECT max_duration, countdown FROM questions WHERE text='Sans défaut'").get();
    assert.equal(q.max_duration, 60);
    assert.equal(q.countdown, 3);
  });

  it('tronque le texte à 500 caractères', () => {
    const edb = freshDb();
    const long = 'x'.repeat(600);
    applyEventConfig(edb, { mode: 'overwrite', questions: [{ text: long }] });

    const q = edb.prepare('SELECT text FROM questions').get();
    assert.equal(q.text.length, 500);
  });

  it('ignore un thème invalide sans erreur', () => {
    const edb = freshDb();
    applyEventConfig(edb, { mode: 'overwrite', meta: { theme: 'inexistant' } });

    const row = edb.prepare("SELECT value FROM event_meta WHERE key='theme'").get();
    assert.equal(row, undefined);
  });

  it('ignore les questions sans texte ou avec texte non-string', () => {
    const edb = freshDb();
    applyEventConfig(edb, {
      mode: 'overwrite',
      questions: [{ text: '' }, { text: 42 }, { text: 'ok' }],
    });
    const qs = edb.prepare('SELECT text FROM questions').all();
    assert.equal(qs.length, 1);
    assert.equal(qs[0].text, 'ok');
  });
});

describe('applyEventConfig — mode merge', () => {
  it('ne remplace pas une meta déjà non-vide', () => {
    const edb = freshDb();
    applyEventConfig(edb, { mode: 'overwrite', meta: { welcome_title: 'existant' } });
    applyEventConfig(edb, { mode: 'merge', meta: { welcome_title: 'ignoré' } });

    const val = edb.prepare("SELECT value FROM event_meta WHERE key='welcome_title'").get().value;
    assert.equal(val, 'existant');
  });

  it('écrit une meta absente ou vide en mode merge', () => {
    const edb = freshDb();
    applyEventConfig(edb, { mode: 'merge', meta: { welcome_title: 'nouveau' } });

    const val = edb.prepare("SELECT value FROM event_meta WHERE key='welcome_title'").get().value;
    assert.equal(val, 'nouveau');
  });

  it('ne duplique pas une question au texte identique', () => {
    const edb = freshDb();
    applyEventConfig(edb, { mode: 'overwrite', questions: [{ text: 'Commune' }] });
    applyEventConfig(edb, { mode: 'merge', questions: [{ text: 'Commune' }, { text: 'Nouvelle' }] });

    const qs = edb.prepare('SELECT text FROM questions ORDER BY order_index').all();
    const texts = qs.map(q => q.text);
    assert.equal(texts.filter(t => t === 'Commune').length, 1);
    assert.ok(texts.includes('Nouvelle'));
  });

  it('conserve les questions existantes en mode merge', () => {
    const edb = freshDb();
    const initialCount = edb.prepare('SELECT COUNT(*) as n FROM questions').get().n;
    applyEventConfig(edb, { mode: 'merge', questions: [{ text: 'Ajout' }] });

    const count = edb.prepare('SELECT COUNT(*) as n FROM questions').get().n;
    assert.equal(count, initialCount + 1);
  });
});

describe('applyEventConfig — meta/questions absents', () => {
  it('ne plante pas si meta est absent', () => {
    const edb = freshDb();
    assert.doesNotThrow(() => applyEventConfig(edb, { mode: 'overwrite', questions: [] }));
  });

  it('ne plante pas si questions est absent', () => {
    const edb = freshDb();
    assert.doesNotThrow(() => applyEventConfig(edb, { mode: 'overwrite', meta: {} }));
  });
});
