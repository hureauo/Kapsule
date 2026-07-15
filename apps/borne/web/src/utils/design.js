import { DESIGN_COLOR_KEYS, RADIUS_PRESETS, FONT_PRESETS } from '@kapsule/core';

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
 */
export function applyDesign(design) {
  const root = document.documentElement;

  for (const name of MANAGED_VARS) {
    root.style.removeProperty(name);
  }

  if (!design) return; // pas de design → le thème figé (data-theme) reprend la main

  for (const key of DESIGN_COLOR_KEYS) {
    const value = design.colors?.[key];
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
