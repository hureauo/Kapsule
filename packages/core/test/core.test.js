import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEventDb } from '../src/eventDbSchema.js';
import { sha256File } from '../src/checksum.js';
import { validateQuestion, validateGuestName, assertStatus } from '../src/validate.js';
import {
  VIDEO_QUALITY, VIDEO_ORIENTATIONS, QUALITY_KEYS,
  DEFAULT_VIDEO_QUALITY, DEFAULT_VIDEO_ORIENTATION, resolvePreset, mbPerMinFromKey,
} from '../src/constants.js';

// ─── createEventDb ────────────────────────────────────────────────────────────

describe('createEventDb', () => {
  test('crée les tables (sans questions par défaut)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kapsule-'));
    try {
      const db = createEventDb(join(dir, 'db.sqlite'));
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);

      assert.ok(tables.includes('event_meta'));
      assert.ok(tables.includes('questions'));
      assert.ok(tables.includes('sessions'));
      assert.ok(tables.includes('videos'));
      assert.ok(tables.includes('derived'));

      const count = db.prepare('SELECT COUNT(*) as n FROM questions').get().n;
      assert.equal(count, 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('est idempotent — appeler deux fois sur la même BD ne plante pas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kapsule-'));
    try {
      const db1 = createEventDb(join(dir, 'db.sqlite'));
      db1.close();
      const db2 = createEventDb(join(dir, 'db.sqlite'));
      const count = db2.prepare('SELECT COUNT(*) as n FROM questions').get().n;
      assert.equal(count, 0);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('WAL et foreign_keys sont activés', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kapsule-'));
    try {
      const db = createEventDb(join(dir, 'db.sqlite'));
      const wal = db.pragma('journal_mode', { simple: true });
      assert.equal(wal, 'wal');
      const fk = db.pragma('foreign_keys', { simple: true });
      assert.equal(fk, 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ─── sha256File ───────────────────────────────────────────────────────────────

describe('sha256File', () => {
  test('calcule le bon hash pour un contenu connu', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kapsule-'));
    try {
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'kapsule');
      // echo -n kapsule | sha256sum → vérifiable indépendamment
      const hash = await sha256File(file);
      // printf 'kapsule' | sha256sum → valeur de référence vérifiable indépendamment
      assert.equal(hash, '8fffc5cf0a53f99d9e9495295382dd4ccdc2dfc73ec3d4d5a3aed3abe012ab3e');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejette si le fichier n\'existe pas', async () => {
    await assert.rejects(() => sha256File('/tmp/kapsule-inexistant-xyz.bin'));
  });
});

// ─── validateQuestion ─────────────────────────────────────────────────────────

describe('validateQuestion', () => {
  test('retourne null pour une question valide', () => {
    assert.equal(validateQuestion({ text: 'Bonjour ?', max_duration: 60, countdown: 3 }), null);
  });

  test('erreur si text vide', () => {
    assert.ok(validateQuestion({ text: '' }));
  });

  test('erreur si text trop long', () => {
    assert.ok(validateQuestion({ text: 'x'.repeat(501) }));
  });

  test('erreur si max_duration hors bornes', () => {
    assert.ok(validateQuestion({ text: 'Ok', max_duration: 5 }));
    assert.ok(validateQuestion({ text: 'Ok', max_duration: 301 }));
  });

  test('erreur si countdown négatif', () => {
    assert.ok(validateQuestion({ text: 'Ok', countdown: -1 }));
  });

  test('pas d\'erreur si max_duration et countdown absents', () => {
    assert.equal(validateQuestion({ text: 'Juste un texte' }), null);
  });
});

// ─── validateGuestName ────────────────────────────────────────────────────────

describe('validateGuestName', () => {
  test('retourne null pour un prénom valide', () => {
    assert.equal(validateGuestName('Alice'), null);
  });

  test('erreur si vide', () => {
    assert.ok(validateGuestName(''));
    assert.ok(validateGuestName('   '));
  });

  test('erreur si trop long', () => {
    assert.ok(validateGuestName('x'.repeat(101)));
  });
});

// ─── assertStatus ─────────────────────────────────────────────────────────────

describe('assertStatus', () => {
  test('accepte une avance valide', () => {
    assert.doesNotThrow(() => assertStatus('preview', 'ready'));
    assert.doesNotThrow(() => assertStatus('ready', 'loaded'));
    assert.doesNotThrow(() => assertStatus('closed', 'pushed'));
    assert.doesNotThrow(() => assertStatus('processed', 'waiting'));
  });

  test('refuse un retour en arrière', () => {
    assert.throws(() => assertStatus('ready', 'preview'));
    assert.throws(() => assertStatus('live', 'loaded'));
  });

  test('refuse un statut identique', () => {
    assert.throws(() => assertStatus('preview', 'preview'));
  });

  test('refuse un statut inconnu', () => {
    assert.throws(() => assertStatus('preview', 'inexistant'));
    assert.throws(() => assertStatus('inconnu', 'ready'));
    assert.throws(() => assertStatus('preview', 'purged'));
    assert.throws(() => assertStatus('draft', 'preview')); // draft supprimé
  });
});

describe('VIDEO_QUALITY / resolvePreset', () => {
  test('les deux orientations exposent les mêmes clés de qualité', () => {
    for (const o of VIDEO_ORIENTATIONS) {
      assert.deepEqual(Object.keys(VIDEO_QUALITY[o]), QUALITY_KEYS);
    }
  });

  test('paysage est horizontal, portrait est vertical', () => {
    for (const key of QUALITY_KEYS) {
      const l = resolvePreset(key, 'paysage');
      const p = resolvePreset(key, 'portrait');
      assert.ok(l.width > l.height, `${key} paysage doit être horizontal`);
      assert.ok(p.height > p.width, `${key} portrait doit être vertical`);
    }
  });

  test('portrait a les dimensions du paysage inversées (à pixels égaux)', () => {
    for (const key of QUALITY_KEYS) {
      const l = resolvePreset(key, 'paysage');
      const p = resolvePreset(key, 'portrait');
      assert.equal(p.width, l.height);
      assert.equal(p.height, l.width);
      assert.equal(p.videoBitrate, l.videoBitrate);
    }
  });

  test('une qualité ou une orientation inconnue retombe sur le défaut, jamais undefined', () => {
    const def = VIDEO_QUALITY[DEFAULT_VIDEO_ORIENTATION][DEFAULT_VIDEO_QUALITY];
    assert.deepEqual(resolvePreset('nawak', 'paysage'), VIDEO_QUALITY.paysage[DEFAULT_VIDEO_QUALITY]);
    assert.deepEqual(resolvePreset('standard', 'diagonale'), VIDEO_QUALITY[DEFAULT_VIDEO_ORIENTATION].standard);
    assert.deepEqual(resolvePreset(undefined, undefined), def);
  });

  test('mbPerMinFromKey : cohérent entre orientations, null si clé inconnue', () => {
    assert.equal(mbPerMinFromKey('standard', 'portrait'), mbPerMinFromKey('standard', 'paysage'));
    assert.equal(mbPerMinFromKey('nawak', 'paysage'), null);
    assert.equal(mbPerMinFromKey('standard', 'diagonale'), null);
    // Défaut d'orientation : appel à un seul argument (compat appelants existants).
    assert.equal(mbPerMinFromKey('standard'), mbPerMinFromKey('standard', DEFAULT_VIDEO_ORIENTATION));
  });
});
