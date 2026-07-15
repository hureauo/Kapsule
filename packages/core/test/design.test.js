import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DESIGN_COLOR_KEYS, DESIGN_RADIUS, DESIGN_FONTS, DESIGN_LAYOUTS,
  DESIGN_MAX_JSON, RADIUS_PRESETS, FONT_PRESETS, validateDesign,
} from '../src/design.js';

// Design minimal valide — sert de base à muter dans chaque cas.
const base = () => ({
  version: 1,
  colors: { bg: '#FFF8EE', accent: '#F27405' },
  radius: 'soft',
  font: 'sans',
  layouts: { start: 'centered', thanks: 'centered' },
  assets: { logo: null, background: null },
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
    assert.deepEqual(DESIGN_LAYOUTS.start, ['centered', 'cover', 'split']);
    assert.deepEqual(DESIGN_LAYOUTS.thanks, ['centered', 'cover']);
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

  test('assets null (pas d\'image)', () => {
    assert.deepEqual(validateDesign({ ...base(), assets: { logo: null } }), { ok: true });
  });

  test('nom de fichier asset valide', () => {
    const logo = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';
    assert.deepEqual(validateDesign({ ...base(), assets: { logo } }), { ok: true });
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

  test('layout hors enum', () => {
    invalid({ ...base(), layouts: { start: 'diagonal' } }, 'start inconnu');
    // 'split' n'existe que pour start, pas pour thanks
    invalid({ ...base(), layouts: { thanks: 'split' } }, 'thanks split');
    invalid({ ...base(), layouts: { unknown_screen: 'centered' } }, 'écran inconnu');
  });

  test('asset : SVG et chemins refusés', () => {
    const uuid = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    invalid({ ...base(), assets: { logo: `${uuid}.svg` } }, 'svg');
    invalid({ ...base(), assets: { logo: '../../etc/passwd' } }, 'path traversal');
    invalid({ ...base(), assets: { logo: `dir/${uuid}.png` } }, 'chemin');
    invalid({ ...base(), assets: { logo: 'logo.png' } }, 'pas un uuid');
    invalid({ ...base(), assets: { evil: `${uuid}.png` } }, 'slot inconnu');
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

  test('JSON trop volumineux (> 16 Ko) → invalide', () => {
    // La garde de taille s'applique avant la validation du contenu : un design dont
    // toutes les clés sont légitimes mais dont une valeur est démesurée est rejeté
    // sur la taille (message dédié), pas seulement sur la forme de la valeur.
    const huge = { ...base(), assets: { logo: 'x'.repeat(DESIGN_MAX_JSON) } };
    const r = validateDesign(huge);
    assert.equal(r.ok, false);
    assert.match(r.error, /octets/);
  });
});
