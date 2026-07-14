import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatSize, formatDate, formatSqlDate, formatDuration, isPortrait } from '../src/utils/format.js';

const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;

describe('formatBytes', () => {
  test('0 / falsy → "0 o"', () => {
    assert.equal(formatBytes(0), '0 o');
    assert.equal(formatBytes(null), '0 o');
  });
  test('Ko sous le Mo', () => assert.equal(formatBytes(512 * KB), '512 Ko'));
  test('Mo sous le Go', () => assert.equal(formatBytes(2.5 * MB), '2.5 Mo'));
  test('Go au-delà', () => assert.equal(formatBytes(3 * GB), '3.00 Go'));
});

describe('formatSize', () => {
  test('falsy → "—"', () => assert.equal(formatSize(0), '—'));
  test('Ko sous le Mo', () => assert.equal(formatSize(700 * KB), '700 Ko'));
  test('plafonne au Mo (pas de Go)', () => assert.equal(formatSize(2 * GB), `${(2 * 1024).toFixed(1)} Mo`));
});

describe('formatDate', () => {
  test('falsy → "—"', () => assert.equal(formatDate(null), '—'));
  test('date valide → chaîne non vide', () => {
    const out = formatDate('2026-06-19T10:00:00Z');
    assert.ok(typeof out === 'string' && out.length > 0 && out !== '—');
  });
});

describe('formatSqlDate', () => {
  test('falsy → "—"', () => assert.equal(formatSqlDate(null), '—'));

  test('timestamp SQLite (UTC sans Z) interprété en UTC, pas en heure locale', () => {
    // SQLite écrit 'YYYY-MM-DD HH:MM:SS' en UTC sans suffixe de zone. Lu tel quel
    // par new Date(), il serait pris pour de l'heure locale → décalage.
    const sqlite = formatSqlDate('2026-06-19 10:00:00');
    const explicit = formatSqlDate('2026-06-19T10:00:00Z');
    assert.equal(sqlite, explicit);
  });

  test('une date déjà ISO est acceptée telle quelle', () => {
    const out = formatSqlDate('2026-06-19T10:00:00Z');
    assert.ok(typeof out === 'string' && out.length > 0 && out !== '—');
  });
});

describe('formatDuration', () => {
  test('null → "—"', () => assert.equal(formatDuration(null), '—'));
  test('0 → "0:00"', () => assert.equal(formatDuration(0), '0:00'));
  test('65 → "1:05" (padding)', () => assert.equal(formatDuration(65), '1:05'));
  test('125 → "2:05"', () => assert.equal(formatDuration(125), '2:05'));
});

describe('isPortrait', () => {
  test('vidéo verticale → true', () => assert.equal(isPortrait({ width: 720, height: 1280 }), true));
  test('vidéo horizontale → false', () => assert.equal(isPortrait({ width: 1280, height: 720 }), false));
  test('vidéo carrée → false (pas verticale)', () => assert.equal(isPortrait({ width: 720, height: 720 }), false));

  // Une vidéo pas encore sondée par le worker n'a ni width ni height : on retombe
  // sur le cadrage paysage, qui est l'orientation par défaut d'un événement.
  test('dimensions absentes → false', () => {
    assert.equal(isPortrait({}), false);
    assert.equal(isPortrait({ width: 720 }), false);
    assert.equal(isPortrait({ width: 0, height: 0 }), false);
    assert.equal(isPortrait(null), false);
    assert.equal(isPortrait(undefined), false);
  });
});
