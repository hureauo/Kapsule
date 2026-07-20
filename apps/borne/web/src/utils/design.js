import { DESIGN_COLOR_KEYS, RADIUS_PRESETS, FONT_PRESETS, resolveScreenColors } from '@kapsule/core';

// Application d'un design au kiosque (§9bis).
//
// Les designs posent des custom properties sur <html>, PAR-DESSUS le thème figé
// (data-theme). L'admin borne n'est pas affecté : .admin-login/.admin-layout
// redéfinissent tous les tokens sur un élément plus profond, et l'héritage CSS
// leur donne raison sur les variables de <html>.
//
// SÉCURITÉ : on itère sur DESIGN_COLOR_KEYS, jamais sur les clés du design reçu.
// Une clé inconnue ne peut donc pas devenir une custom property, même si elle
// avait survécu à la validation en amont.

// Variables posées par un design. On les retire toutes avant d'en appliquer un
// nouveau : sans ce nettoyage, les couleurs d'un design précédent survivraient
// aux clés absentes du suivant.
const MANAGED_VARS = [
  ...DESIGN_COLOR_KEYS.map((k) => `--${k}`),
  '--radius',
  '--radius-pill',
  '--font-body',
];

/**
 * Applique (ou retire) un design sur <html>.
 * @param {object|null} design — l'objet exposé par GET /api/event, ou null.
 * @param {string} [screen] — écran design courant (design3, un des DESIGN_SCREENS
 *   de @kapsule/core). Omis ou inconnu → couleurs globales (comportement d'avant
 *   design3, appelants existants non affectés par ce paramètre optionnel).
 */
export function applyDesign(design, screen) {
  const root = document.documentElement;

  for (const name of MANAGED_VARS) {
    root.style.removeProperty(name);
  }

  if (!design) return; // pas de design → le thème figé (data-theme) reprend la main

  // resolveScreenColors résout déjà "surcharge écran > global > absent" en
  // n'itérant que sur DESIGN_COLOR_KEYS (même barrière anti-injection que le
  // reste de ce fichier) — source unique partagée avec l'éditeur Hub.
  const colors = resolveScreenColors(design, screen);
  for (const key of DESIGN_COLOR_KEYS) {
    const value = colors[key];
    if (value) root.style.setProperty(`--${key}`, value);
  }

  const radius = RADIUS_PRESETS[design.radius];
  if (radius) {
    root.style.setProperty('--radius', radius.radius);
    root.style.setProperty('--radius-pill', radius.pill);
  }

  const font = FONT_PRESETS[design.font];
  if (font) root.style.setProperty('--font-body', font);
}

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
