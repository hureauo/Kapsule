import { DESIGN_COLOR_KEYS, RADIUS_PRESETS, FONT_PRESETS, resolveScreenColors } from '@kapsule/core';

// Résolution d'un design en custom properties CSS — fonction pure, source
// unique partagée par le runtime borne (posées sur <html>, cf. applyDesign
// dans apps/borne/web/src/utils/design.js) et l'aperçu live Hub (posées en
// inline sur le wrapper .kapsule-guest, scope local). Avant ce chantier,
// cette logique était dupliquée (applyDesign côté borne, cssVarsFor côté Hub).
//
// SÉCURITÉ : on itère sur DESIGN_COLOR_KEYS, jamais sur les clés du design
// reçu — une clé inconnue ne peut donc pas devenir une custom property, même
// si elle avait survécu à la validation en amont (§11.28).
//
// @param {object|null} design — objet design (config Hub ou event.design borne).
// @param {string} [screen] — écran courant (un des DESIGN_SCREENS de @kapsule/core).
//   Omis ou inconnu → couleurs globales.
// @returns {object} des custom properties CSS ({'--bg': '#...', ...}), prêtes à
//   être posées via root.style.setProperty ou en style React inline.
export function designToVars(design, screen) {
  const vars = {};
  if (!design) return vars;

  const colors = resolveScreenColors(design, screen);
  for (const key of DESIGN_COLOR_KEYS) {
    const value = colors[key];
    if (value) vars[`--${key}`] = value;
  }

  const radius = RADIUS_PRESETS[design.radius];
  if (radius) {
    vars['--radius'] = radius.radius;
    vars['--radius-pill'] = radius.pill;
  }

  const font = FONT_PRESETS[design.font];
  if (font) vars['--font-body'] = font;

  return vars;
}

// Liste des custom properties qu'un design peut poser — utilisée par le
// runtime borne pour nettoyer les valeurs d'un design précédent avant d'en
// appliquer un nouveau (cf. applyDesign).
export const MANAGED_DESIGN_VARS = [
  ...DESIGN_COLOR_KEYS.map((k) => `--${k}`),
  '--radius',
  '--radius-pill',
  '--font-body',
];

/**
 * Style inline pour l'image d'un écran en mode 'centered' (design5).
 * widthPercent absent → undefined : le CSS par défaut (max-height:120px)
 * s'applique inchangé. widthPercent défini → largeur prioritaire (option A) :
 * le plafond de hauteur est retiré, l'image grandit selon son ratio naturel.
 * @param {{mode?: string, widthPercent?: number}} image
 */
export function imageWidthStyle(image) {
  if (image?.mode !== 'centered' || !Number.isInteger(image?.widthPercent)) return undefined;
  return { width: `${image.widthPercent}%`, maxWidth: `${image.widthPercent}%`, maxHeight: 'none' };
}
