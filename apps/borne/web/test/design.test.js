import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_COLOR_KEYS } from '@kapsule/core';

// applyDesign manipule document.documentElement.style. On simule le strict
// minimum de l'API CSSStyleDeclaration utilisée (setProperty/removeProperty),
// ce qui suffit à vérifier ce qui compte : la whitelist et le nettoyage.
function fakeDocument() {
  const props = new Map();
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => props.set(name, value),
        removeProperty: (name) => props.delete(name),
      },
    },
  };
  return props;
}

let props;
let applyDesign;

beforeEach(async () => {
  props = fakeDocument();
  // Import après la pose du faux document (le module ne le touche qu'à l'appel,
  // mais on garde l'ordre explicite).
  ({ applyDesign } = await import('../src/utils/design.js'));
});

afterEach(() => {
  delete globalThis.document;
});

describe('applyDesign', () => {
  test('pose les couleurs du design en custom properties', () => {
    applyDesign({ colors: { bg: '#101020', accent: '#ff8800' } });

    assert.equal(props.get('--bg'), '#101020');
    assert.equal(props.get('--accent'), '#ff8800');
  });

  test('n\'applique QUE les clés connues (whitelist, jamais les clés reçues)', () => {
    applyDesign({
      colors: {
        bg: '#ffffff',
        // Une clé hostile qui aurait échappé à la validation en amont ne doit
        // pas pouvoir devenir une custom property.
        'evil; background: url(x)': 'red',
        'font-family': 'Comic Sans',
      },
    });

    assert.equal(props.get('--bg'), '#ffffff');
    for (const name of props.keys()) {
      const key = name.slice(2); // retire '--'
      assert.ok(
        DESIGN_COLOR_KEYS.includes(key) || ['radius', 'radius-pill', 'font-body'].includes(key),
        `propriété inattendue posée : ${name}`,
      );
    }
  });

  test('traduit les presets de rayon et de police', () => {
    applyDesign({ colors: {}, radius: 'round', font: 'serif' });

    assert.equal(props.get('--radius'), '28px');
    assert.equal(props.get('--radius-pill'), '999px');
    assert.match(props.get('--font-body'), /Georgia/);
  });

  test('un preset inconnu est ignoré (pas de valeur CSS arbitraire)', () => {
    applyDesign({ colors: {}, radius: 'inexistant', font: 'inexistante' });

    assert.equal(props.has('--radius'), false);
    assert.equal(props.has('--font-body'), false);
  });

  test('applyDesign(null) nettoie TOUT (retour au thème figé)', () => {
    applyDesign({ colors: { bg: '#000000', accent: '#ffffff' }, radius: 'sharp', font: 'mono' });
    assert.ok(props.size > 0);

    applyDesign(null);
    assert.equal(props.size, 0, 'aucune variable de design ne doit subsister');
  });

  test('changer de design retire les couleurs absentes du nouveau', () => {
    applyDesign({ colors: { bg: '#000000', accent: '#ffffff' } });
    applyDesign({ colors: { bg: '#ff0000' } }); // plus d'accent

    assert.equal(props.get('--bg'), '#ff0000');
    assert.equal(props.has('--accent'), false, 'la couleur de l\'ancien design doit disparaître');
  });
});
