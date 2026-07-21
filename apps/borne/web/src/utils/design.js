import { designToVars, MANAGED_DESIGN_VARS, imageWidthStyle } from '@kapsule/guest-ui/design';

// Application d'un design au kiosque (§9bis).
//
// Les designs posent des custom properties sur <html>, PAR-DESSUS le thème figé
// (data-theme). L'admin borne n'est pas affecté : .admin-login/.admin-layout
// redéfinissent tous les tokens sur un élément plus profond, et l'héritage CSS
// leur donne raison sur les variables de <html>.
//
// designToVars (designUI, @kapsule/guest-ui) résout le design en custom
// properties — même fonction pure que l'aperçu live Hub (posées en inline sur
// son wrapper), pas de calcul dupliqué.

/**
 * Applique (ou retire) un design sur <html>.
 * @param {object|null} design — l'objet exposé par GET /api/event, ou null.
 * @param {string} [screen] — écran design courant (design3, un des DESIGN_SCREENS
 *   de @kapsule/core). Omis ou inconnu → couleurs globales (comportement d'avant
 *   design3, appelants existants non affectés par ce paramètre optionnel).
 */
export function applyDesign(design, screen) {
  const root = document.documentElement;

  for (const name of MANAGED_DESIGN_VARS) {
    root.style.removeProperty(name);
  }

  if (!design) return; // pas de design → le thème figé (data-theme) reprend la main

  const vars = designToVars(design, screen);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export { imageWidthStyle };
