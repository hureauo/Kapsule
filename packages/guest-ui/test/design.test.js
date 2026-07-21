import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_COLOR_KEYS } from '@kapsule/core';
import { designToVars, MANAGED_DESIGN_VARS, imageWidthStyle } from '../src/design.js';

// designToVars est la source unique consommée par applyDesign (borne, pose sur
// <html>) et par l'aperçu Hub (pose en inline sur .kapsule-guest) — les deux
// callers sont déjà couverts indirectement (apps/borne/web/test/design.test.js
// pour applyDesign). Ici on teste la fonction pure elle-même.

describe('designToVars', () => {
  test('design null ou absent → objet vide', () => {
    assert.deepEqual(designToVars(null), {});
    assert.deepEqual(designToVars(undefined), {});
  });

  test('résout les couleurs globales en custom properties', () => {
    const vars = designToVars({ colors: { bg: '#101020', accent: '#ff8800' } });
    assert.equal(vars['--bg'], '#101020');
    assert.equal(vars['--accent'], '#ff8800');
  });

  test('n\'expose QUE les clés connues (whitelist, jamais les clés reçues)', () => {
    const vars = designToVars({
      colors: { bg: '#ffffff', 'evil; background: url(x)': 'red', 'font-family': 'Comic Sans' },
    });
    assert.equal(vars['--bg'], '#ffffff');
    for (const name of Object.keys(vars)) {
      const key = name.slice(2);
      assert.ok(
        DESIGN_COLOR_KEYS.includes(key) || ['radius', 'radius-pill', 'font-body'].includes(key),
        `propriété inattendue : ${name}`,
      );
    }
  });

  test('traduit les presets de rayon et de police', () => {
    const vars = designToVars({ colors: {}, radius: 'round', font: 'serif' });
    assert.equal(vars['--radius'], '28px');
    assert.equal(vars['--radius-pill'], '999px');
    assert.match(vars['--font-body'], /Georgia/);
  });

  test('un preset inconnu est ignoré (pas de valeur CSS arbitraire)', () => {
    const vars = designToVars({ colors: {}, radius: 'inexistant', font: 'inexistante' });
    assert.equal('--radius' in vars, false);
    assert.equal('--font-body' in vars, false);
  });

  test('résout la surcharge de l\'écran demandé (design3)', () => {
    const vars = designToVars({
      colors: { bg: '#101020', text: '#eeeeee' },
      screenOverrides: { start: { colors: { text: '#0000ff' } } },
    }, 'start');
    assert.equal(vars['--bg'], '#101020'); // hérite (pas surchargé)
    assert.equal(vars['--text'], '#0000ff'); // surchargé pour 'start'
  });
});

describe('MANAGED_DESIGN_VARS', () => {
  test('couvre toutes les clés couleur + radius/radius-pill/font-body', () => {
    assert.equal(MANAGED_DESIGN_VARS.length, DESIGN_COLOR_KEYS.length + 3);
    assert.ok(MANAGED_DESIGN_VARS.includes('--radius-pill'));
    assert.ok(MANAGED_DESIGN_VARS.includes('--font-body'));
  });
});

describe('imageWidthStyle', () => {
  test('absent hors mode centered', () => {
    assert.equal(imageWidthStyle({ mode: 'cover', widthPercent: 50 }), undefined);
    assert.equal(imageWidthStyle({ mode: 'none' }), undefined);
  });

  test('absent si widthPercent non entier', () => {
    assert.equal(imageWidthStyle({ mode: 'centered' }), undefined);
    assert.equal(imageWidthStyle({ mode: 'centered', widthPercent: '50' }), undefined);
  });

  test('style largeur prioritaire quand widthPercent défini en mode centered', () => {
    assert.deepEqual(imageWidthStyle({ mode: 'centered', widthPercent: 42 }), {
      width: '42%', maxWidth: '42%', maxHeight: 'none',
    });
  });
});
