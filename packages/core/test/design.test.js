import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DESIGN_COLOR_KEYS, DESIGN_RADIUS, DESIGN_FONTS, DESIGN_SCREENS,
  DESIGN_IMAGE_SCREENS, DESIGN_IMAGE_MODES,
  DESIGN_MAX_JSON, RADIUS_PRESETS, FONT_PRESETS, validateDesign, resolveScreenColors,
} from '../src/design.js';

// Design minimal valide — sert de base à muter dans chaque cas.
const base = () => ({
  version: 1,
  colors: { bg: '#FFF8EE', accent: '#F27405' },
  radius: 'soft',
  font: 'sans',
  images: {
    start: { mode: 'none', filename: null },
    thanks: { mode: 'none', filename: null },
  },
});

describe('constantes design', () => {
  test('DESIGN_COLOR_KEYS contient les 18 clés de couleur', () => {
    assert.equal(DESIGN_COLOR_KEYS.length, 18);
    assert.ok(DESIGN_COLOR_KEYS.includes('bg'));
    assert.ok(DESIGN_COLOR_KEYS.includes('btn-secondary-hover'));
    // Les non-couleurs ne doivent PAS être éditables (presets / non exposés).
    for (const excluded of ['radius', 'radius-pill', 'shadow-soft', 'shadow-press', 'rec']) {
      assert.ok(!DESIGN_COLOR_KEYS.includes(excluded), `${excluded} ne doit pas être une clé couleur`);
    }
  });

  test('les enums sont fermées', () => {
    assert.deepEqual(DESIGN_RADIUS, ['sharp', 'soft', 'round']);
    assert.deepEqual(DESIGN_FONTS, ['sans', 'serif', 'rounded', 'mono', 'humanist', 'grotesk', 'slab', 'elegant']);
    assert.deepEqual(DESIGN_SCREENS, ['start', 'name', 'recording', 'thanks']);
    assert.deepEqual(DESIGN_IMAGE_SCREENS, ['start', 'thanks']);
    assert.deepEqual(DESIGN_IMAGE_MODES, ['centered', 'cover', 'none']);
  });

  test('chaque valeur d\'enum a son preset CSS (aperçu Hub et kiosque partagent la source)', () => {
    // Sans cette garde, ajouter un radius/une police à l'enum sans son mapping
    // laisserait le runtime sans valeur CSS — panne silencieuse côté borne.
    for (const key of DESIGN_RADIUS) {
      assert.ok(RADIUS_PRESETS[key], `preset de rayon manquant : ${key}`);
      assert.equal(typeof RADIUS_PRESETS[key].radius, 'string');
      assert.equal(typeof RADIUS_PRESETS[key].pill, 'string');
    }
    for (const key of DESIGN_FONTS) {
      assert.equal(typeof FONT_PRESETS[key], 'string', `stack de police manquante : ${key}`);
    }
    assert.equal(Object.keys(RADIUS_PRESETS).length, DESIGN_RADIUS.length);
    assert.equal(Object.keys(FONT_PRESETS).length, DESIGN_FONTS.length);
  });
});

describe('validateDesign — cas valides', () => {
  test('design complet', () => {
    assert.deepEqual(validateDesign(base()), { ok: true });
  });

  test('toutes les clés de couleur renseignées', () => {
    const colors = Object.fromEntries(DESIGN_COLOR_KEYS.map(k => [k, '#123456']));
    assert.deepEqual(validateDesign({ ...base(), colors }), { ok: true });
  });

  test('hex 8 chiffres (canal alpha) accepté', () => {
    assert.deepEqual(validateDesign({ ...base(), colors: { bg: '#11223344' } }), { ok: true });
  });

  test('clés optionnelles absentes (fallback thème)', () => {
    assert.deepEqual(validateDesign({ version: 1 }), { ok: true });
  });

  test('images absentes reste valide (rétrocompatibilité)', () => {
    const { images, ...withoutImages } = base();
    assert.deepEqual(validateDesign(withoutImages), { ok: true });
  });

  test('images.<screen> mode "none" avec filename null', () => {
    const design = { ...base(), images: { start: { mode: 'none', filename: null } } };
    assert.deepEqual(validateDesign(design), { ok: true });
  });

  test('images.<screen> mode "centered"/"cover" avec un nom de fichier valide', () => {
    const filename = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';
    assert.deepEqual(
      validateDesign({ ...base(), images: { start: { mode: 'centered', filename } } }),
      { ok: true },
    );
    assert.deepEqual(
      validateDesign({ ...base(), images: { thanks: { mode: 'cover', filename } } }),
      { ok: true },
    );
  });

  test('screenOverrides absent reste valide (rétrocompatibilité design2 et antérieurs)', () => {
    assert.deepEqual(validateDesign(base()), { ok: true });
    assert.equal('screenOverrides' in base(), false);
  });

  test('screenOverrides : surcharge partielle sur un seul écran', () => {
    const design = { ...base(), screenOverrides: { start: { colors: { text: '#0000ff' } } } };
    assert.deepEqual(validateDesign(design), { ok: true });
  });

  test('screenOverrides : surcharge complète sur plusieurs écrans', () => {
    const design = {
      ...base(),
      screenOverrides: {
        start: { colors: { text: '#0000ff', bg: '#111111' } },
        name: { colors: {} },
        recording: { colors: { primary: '#ff0000', 'text-error': '#aa0000' } },
        thanks: { colors: { accent: '#00ff00' } },
      },
    };
    assert.deepEqual(validateDesign(design), { ok: true });
  });
});

describe('validateDesign — cas invalides', () => {
  const invalid = (design, motif) => {
    const r = validateDesign(design);
    assert.equal(r.ok, false, `attendu invalide : ${motif}`);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  };

  test('version absente ou différente de 1', () => {
    invalid({ colors: {} }, 'version absente');
    invalid({ version: 2 }, 'version 2');
    invalid({ version: '1' }, 'version string');
  });

  test('non-objet', () => {
    invalid(null, 'null');
    invalid('x', 'string');
    invalid([], 'array');
  });

  test('clé de couleur inconnue → invalide', () => {
    invalid({ ...base(), colors: { bg: '#ffffff', 'evil-key': '#000000' } }, 'clé inconnue');
  });

  test('hex malformé', () => {
    invalid({ ...base(), colors: { bg: '#fff' } }, 'hex 3 chiffres');
    invalid({ ...base(), colors: { bg: 'red' } }, 'nom CSS');
    invalid({ ...base(), colors: { bg: '#gggggg' } }, 'hors hex');
    invalid({ ...base(), colors: { bg: 123456 } }, 'nombre');
  });

  test('valeur CSS libre refusée (anti-injection)', () => {
    invalid({ ...base(), colors: { bg: 'url(https://evil.example/x.png)' } }, 'url()');
    invalid({ ...base(), colors: { bg: 'expression(alert(1))' } }, 'expression()');
    invalid({ ...base(), colors: { bg: '#fff; background: url(x)' } }, 'injection point-virgule');
  });

  test('radius / font hors enum', () => {
    invalid({ ...base(), radius: 'huge' }, 'radius inconnu');
    invalid({ ...base(), font: 'comic' }, 'font inconnue');
  });

  test('images : écran inconnu → invalide', () => {
    invalid({ ...base(), images: { unknown_screen: { mode: 'none', filename: null } } }, 'écran inconnu');
  });

  test('images : mode hors enum → invalide', () => {
    invalid({ ...base(), images: { start: { mode: 'split', filename: null } } }, 'mode split retiré (design4)');
    invalid({ ...base(), images: { start: { mode: 'diagonal', filename: null } } }, 'mode inconnu');
  });

  test('images : incohérence mode/filename → invalide', () => {
    const filename = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';
    invalid({ ...base(), images: { start: { mode: 'none', filename } } }, 'filename présent alors que mode=none');
    invalid({ ...base(), images: { start: { mode: 'cover', filename: null } } }, 'filename manquant alors que mode=cover');
    invalid({ ...base(), images: { start: { mode: 'centered' } } }, 'filename absent alors que mode=centered');
  });

  test('images : clé inconnue à l\'intérieur d\'un écran → invalide', () => {
    invalid({ ...base(), images: { start: { mode: 'none', filename: null, extra: true } } }, 'clé extra');
  });

  test('images : SVG et chemins refusés', () => {
    const uuid = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    invalid({ ...base(), images: { start: { mode: 'centered', filename: `${uuid}.svg` } } }, 'svg');
    invalid({ ...base(), images: { start: { mode: 'centered', filename: '../../etc/passwd' } } }, 'path traversal');
    invalid({ ...base(), images: { start: { mode: 'centered', filename: `dir/${uuid}.png` } } }, 'chemin');
    invalid({ ...base(), images: { start: { mode: 'centered', filename: 'logo.png' } } }, 'pas un uuid');
  });

  test('images : forme incorrecte → invalide', () => {
    invalid({ ...base(), images: 'not-an-object' }, 'images non-objet');
    invalid({ ...base(), images: { start: 'not-an-object' } }, 'images.start non-objet');
    invalid({ ...base(), images: [] }, 'images array');
  });

  test('clé racine inconnue → invalide (whitelist du 1er niveau)', () => {
    // Sans cette garde, la clé serait persistée verbatim puis recopiée dans
    // event_meta.design et servie au kiosque.
    invalid({ ...base(), style: 'position:fixed' }, 'clé racine style');
    invalid({ ...base(), '--evil': 'url(https://evil.test/x)' }, 'custom property injectée');
    invalid({ ...base(), filler: 'x' }, 'clé racine quelconque');
    // Ce que produit réellement JSON.parse('{"__proto__":…}') : une clé PROPRE
    // (contrairement au littéral JS, où __proto__ définit le prototype).
    invalid(JSON.parse('{"version":1,"__proto__":{"polluted":true}}'), 'pollution de prototype');
  });

  test('un design nominal reste très en dessous de la limite de taille', () => {
    const full = { ...base(), colors: Object.fromEntries(DESIGN_COLOR_KEYS.map(k => [k, '#ffffff'])) };
    assert.ok(JSON.stringify(full).length < DESIGN_MAX_JSON);
    assert.deepEqual(validateDesign(full), { ok: true });
  });

  test('screenOverrides : écran inconnu → invalide', () => {
    invalid({ ...base(), screenOverrides: { unknown_screen: { colors: {} } } }, 'écran inconnu');
  });

  test('screenOverrides : clé couleur inconnue dans une surcharge → invalide', () => {
    invalid({ ...base(), screenOverrides: { start: { colors: { 'evil-key': '#000000' } } } }, 'clé couleur inconnue');
  });

  test('screenOverrides : hex malformé dans une surcharge → invalide', () => {
    invalid({ ...base(), screenOverrides: { start: { colors: { bg: '#fff' } } } }, 'hex 3 chiffres');
    invalid({ ...base(), screenOverrides: { start: { colors: { bg: 'red' } } } }, 'nom CSS');
  });

  test('screenOverrides : valeur CSS libre refusée dans une surcharge (anti-injection)', () => {
    invalid({ ...base(), screenOverrides: { start: { colors: { bg: 'url(https://evil.example/x.png)' } } } }, 'url() dans surcharge');
  });

  test('screenOverrides : clé inconnue à l\'intérieur d\'un écran → invalide', () => {
    invalid({ ...base(), screenOverrides: { start: { radius: 'soft' } } }, 'radius dans screenOverrides.start');
  });

  test('screenOverrides : forme incorrecte → invalide', () => {
    invalid({ ...base(), screenOverrides: 'not-an-object' }, 'screenOverrides non-objet');
    invalid({ ...base(), screenOverrides: { start: 'not-an-object' } }, 'screenOverrides.start non-objet');
    invalid({ ...base(), screenOverrides: [] }, 'screenOverrides array');
  });

  test('JSON trop volumineux (> 16 Ko) → invalide', () => {
    // La garde de taille s'applique avant la validation du contenu : un design dont
    // toutes les clés sont légitimes mais dont une valeur est démesurée est rejeté
    // sur la taille (message dédié), pas seulement sur la forme de la valeur.
    const huge = { ...base(), images: { start: { mode: 'centered', filename: 'x'.repeat(DESIGN_MAX_JSON) } } };
    const r = validateDesign(huge);
    assert.equal(r.ok, false);
    assert.match(r.error, /octets/);
  });
});

describe('resolveScreenColors', () => {
  test('sans surcharge, retombe sur les couleurs globales', () => {
    const config = { ...base(), colors: { bg: '#111111', text: '#eeeeee' } };
    assert.deepEqual(resolveScreenColors(config, 'start'), { bg: '#111111', text: '#eeeeee' });
  });

  test('applique la surcharge d\'un écran et ignore les autres écrans', () => {
    const config = {
      ...base(),
      colors: { bg: '#111111', text: '#eeeeee' },
      screenOverrides: { start: { colors: { text: '#0000ff' } } },
    };
    assert.deepEqual(resolveScreenColors(config, 'start'), { bg: '#111111', text: '#0000ff' });
    // 'name' n'a pas de surcharge → couleurs globales intactes.
    assert.deepEqual(resolveScreenColors(config, 'name'), { bg: '#111111', text: '#eeeeee' });
  });

  test('surcharge partielle d\'un écran : seule la clé surchargée change, le reste hérite', () => {
    const config = {
      ...base(),
      colors: { bg: '#111111', text: '#eeeeee', accent: '#ff8800' },
      screenOverrides: { recording: { colors: { accent: '#00ff00' } } },
    };
    assert.deepEqual(resolveScreenColors(config, 'recording'), {
      bg: '#111111', text: '#eeeeee', accent: '#00ff00',
    });
  });

  test('écran hors DESIGN_SCREENS retombe silencieusement sur le global', () => {
    const config = { ...base(), colors: { bg: '#111111' }, screenOverrides: { start: { colors: { bg: '#0000ff' } } } };
    assert.deepEqual(resolveScreenColors(config, 'unknown_screen'), { bg: '#111111' });
  });

  test('config vide/absente ne casse pas (retourne un objet vide)', () => {
    assert.deepEqual(resolveScreenColors(undefined, 'start'), {});
    assert.deepEqual(resolveScreenColors({}, 'start'), {});
    assert.deepEqual(resolveScreenColors({ version: 1 }, 'start'), {});
  });

  test('itère uniquement sur DESIGN_COLOR_KEYS, jamais sur les clés reçues (barrière anti-injection)', () => {
    const config = {
      ...base(),
      colors: { bg: '#111111' },
      screenOverrides: { start: { colors: { 'evil; background: url(x)': 'red' } } },
    };
    // Un design invalide échapperait normalement à validateDesign en amont, mais
    // resolveScreenColors doit rester sûre seule : la clé hostile ne doit jamais
    // apparaître dans le résultat, même si elle a été écrite directement en config.
    const resolved = resolveScreenColors(config, 'start');
    assert.ok(!('evil; background: url(x)' in resolved));
    assert.deepEqual(resolved, { bg: '#111111' });
  });
});
