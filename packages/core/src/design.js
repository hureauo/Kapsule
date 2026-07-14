// Contrat d'un design personnalisable (PROJET.md §9bis, invariant §11.28).
//
// La validation est la BARRIÈRE ANTI-INJECTION CSS : les valeurs d'un design finissent
// en custom properties CSS sur le kiosque. On n'accepte donc AUCUNE valeur CSS libre —
// uniquement des couleurs hex strictes, des enums fermées et des noms de fichiers image
// raster. Toute la validation itère sur NOS listes de clés, jamais sur les clés reçues :
// une clé inconnue rend le design invalide au lieu d'être copiée telle quelle.
//
// Fonction pure, sans dépendance Node : importable par le backend Hub, le front Hub
// (éditeur) et le front Borne (runtime kiosque).

// Les 18 custom properties de couleur d'app.css, sans le préfixe '--'.
// Exclues volontairement : --radius/--radius-pill (presets), --shadow-*/--rec (non éditables).
export const DESIGN_COLOR_KEYS = [
  'bg', 'surface', 'surface-alt',
  'text', 'text-muted', 'text-error',
  'primary', 'primary-soft', 'primary-tint',
  'accent', 'accent-hover', 'accent-soft', 'accent-tint',
  'input-bg', 'input-border', 'input-border-focus',
  'btn-secondary-bg', 'btn-secondary-hover',
];

export const DESIGN_RADIUS = ['sharp', 'soft', 'round'];
export const DESIGN_FONTS = ['sans', 'serif', 'rounded', 'mono'];
export const DESIGN_LAYOUTS = {
  start: ['centered', 'cover', 'split'],
  thanks: ['centered', 'cover'],
};

export const DESIGN_ASSET_SLOTS = ['logo', 'background'];
// Les SEULES clés admises à la racine d'un design. Une clé inconnue ici serait
// stockée verbatim puis recopiée dans event_meta.design et servie au kiosque :
// c'est le premier niveau de la barrière, pas un détail cosmétique.
export const DESIGN_KEYS = ['version', 'colors', 'radius', 'font', 'layouts', 'assets'];
export const DESIGN_VERSION = 1;
export const DESIGN_MAX_JSON = 16384;

// Mappings des presets vers les valeurs CSS réelles. Partagés par l'éditeur Hub
// (aperçu live) et le runtime kiosque : une seule source, pas de dérive possible
// entre ce que le client voit dans l'aperçu et ce que la borne rend.
export const RADIUS_PRESETS = {
  sharp: { radius: '4px', pill: '8px' },
  soft: { radius: '16px', pill: '999px' },
  round: { radius: '28px', pill: '999px' },
};

export const FONT_PRESETS = {
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  rounded: "'Comic Sans MS', 'Marker Felt', casual, sans-serif",
  mono: "'SF Mono', 'Cascadia Code', monospace",
};

// Hex 6 ou 8 chiffres (8 = canal alpha). Rien d'autre : pas de rgb(), pas de nom CSS.
const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
// UUID + extension raster. Jamais de chemin (pas de '/', pas de '..'), jamais de SVG.
const ASSET_FILENAME_RE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

const fail = (error) => ({ ok: false, error });

/**
 * Valide un objet design contre le contrat version 1.
 * @param {unknown} obj
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateDesign(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail('Le design doit être un objet.');
  }

  // Whitelist racine AVANT tout le reste : rien qui ne soit prévu par le contrat
  // ne doit pouvoir être persisté, même inerte (il finirait dans event_meta.design).
  for (const key of Object.keys(obj)) {
    if (!DESIGN_KEYS.includes(key)) {
      return fail(`Clé de design inconnue : ${key}.`);
    }
  }

  if (obj.version !== DESIGN_VERSION) {
    return fail(`version doit valoir ${DESIGN_VERSION}.`);
  }

  // Taille : borne la charge stockée en base et transférée dans le bundle de pull.
  let serialized;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    return fail('Le design n\'est pas sérialisable en JSON.');
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > DESIGN_MAX_JSON) {
    return fail(`Le design dépasse ${DESIGN_MAX_JSON} octets (${bytes}).`);
  }

  // ── colors ────────────────────────────────────────────────────────────────
  if (obj.colors !== undefined) {
    const colors = obj.colors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
      return fail('colors doit être un objet.');
    }
    // Clé inconnue → invalide. On compare l'ensemble reçu à notre whitelist, mais on
    // n'itère jamais sur les clés reçues pour LIRE des valeurs (cf. en-tête).
    for (const key of Object.keys(colors)) {
      if (!DESIGN_COLOR_KEYS.includes(key)) {
        return fail(`Clé de couleur inconnue : ${key}.`);
      }
    }
    for (const key of DESIGN_COLOR_KEYS) {
      const value = colors[key];
      if (value === undefined) continue; // clé manquante autorisée → fallback thème
      if (typeof value !== 'string' || !HEX_RE.test(value)) {
        return fail(`colors.${key} doit être une couleur hexadécimale (#rrggbb ou #rrggbbaa).`);
      }
    }
  }

  // ── radius / font ─────────────────────────────────────────────────────────
  if (obj.radius !== undefined && !DESIGN_RADIUS.includes(obj.radius)) {
    return fail(`radius doit valoir ${DESIGN_RADIUS.join(', ')}.`);
  }
  if (obj.font !== undefined && !DESIGN_FONTS.includes(obj.font)) {
    return fail(`font doit valoir ${DESIGN_FONTS.join(', ')}.`);
  }

  // ── layouts ───────────────────────────────────────────────────────────────
  if (obj.layouts !== undefined) {
    const layouts = obj.layouts;
    if (!layouts || typeof layouts !== 'object' || Array.isArray(layouts)) {
      return fail('layouts doit être un objet.');
    }
    for (const key of Object.keys(layouts)) {
      if (!Object.hasOwn(DESIGN_LAYOUTS, key)) {
        return fail(`Écran de layout inconnu : ${key}.`);
      }
    }
    for (const [screen, allowed] of Object.entries(DESIGN_LAYOUTS)) {
      const value = layouts[screen];
      if (value === undefined) continue;
      if (!allowed.includes(value)) {
        return fail(`layouts.${screen} doit valoir ${allowed.join(', ')}.`);
      }
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────
  if (obj.assets !== undefined) {
    const assets = obj.assets;
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
      return fail('assets doit être un objet.');
    }
    for (const key of Object.keys(assets)) {
      if (!DESIGN_ASSET_SLOTS.includes(key)) {
        return fail(`Slot d'asset inconnu : ${key}.`);
      }
    }
    for (const slot of DESIGN_ASSET_SLOTS) {
      const value = assets[slot];
      if (value === undefined || value === null) continue; // null = pas d'image
      if (typeof value !== 'string' || !ASSET_FILENAME_RE.test(value)) {
        return fail(`assets.${slot} doit être un nom de fichier <uuid>.png|jpg|webp.`);
      }
    }
  }

  return { ok: true };
}
