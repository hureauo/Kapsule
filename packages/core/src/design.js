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
export const DESIGN_FONTS = ['sans', 'serif', 'rounded', 'mono', 'humanist', 'grotesk', 'slab', 'elegant'];

// Les 4 écrans du parcours invité pouvant recevoir une surcharge de couleurs
// (design3). Correspond aux états S.START/S.NAME/S.QUESTIONS/S.THANKS de
// GuestPage.jsx (borne) — QUESTIONS ↔ 'recording' est la seule correspondance
// non littérale, câblée côté runtime.
export const DESIGN_SCREENS = ['start', 'name', 'recording', 'thanks'];

// design4 : une seule image par écran (accueil/remerciement), 3 états exacts.
// Remplace l'ancien couple assets{logo,background} + layouts{centered,cover,split} —
// un seul système au lieu de deux à coordonner. 'split' (logo à gauche, texte à
// droite) est retiré : il n'avait de sens que séparé du texte, ce qui n'existe
// plus avec une image unique par écran.
export const DESIGN_IMAGE_SCREENS = ['start', 'thanks'];
export const DESIGN_IMAGE_MODES = ['centered', 'cover', 'none'];

// design5 : largeur de l'image en mode 'centered' (pourcentage entier borné).
// Bornes exportées pour que l'éditeur Hub règle son <input type="range"> sur
// la MÊME source que la validation — jamais dupliquées.
export const DESIGN_IMAGE_WIDTH_MIN = 10;
export const DESIGN_IMAGE_WIDTH_MAX = 100;

// Les SEULES clés admises à la racine d'un design. Une clé inconnue ici serait
// stockée verbatim puis recopiée dans event_meta.design et servie au kiosque :
// c'est le premier niveau de la barrière, pas un détail cosmétique.
export const DESIGN_KEYS = ['version', 'colors', 'radius', 'font', 'images', 'screenOverrides'];
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
  humanist: "'Optima', 'Segoe UI', 'Helvetica Neue', sans-serif",
  grotesk: "'Helvetica Neue', Arial, sans-serif",
  slab: "'Rockwell', 'Courier Bold', Georgia, serif",
  elegant: "'Didot', 'Bodoni MT', Georgia, serif",
};

// Hex 6 ou 8 chiffres (8 = canal alpha). Rien d'autre : pas de rgb(), pas de nom CSS.
const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
// UUID + extension raster. Jamais de chemin (pas de '/', pas de '..'), jamais de SVG.
const ASSET_FILENAME_RE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

/**
 * Un nom de fichier d'asset est-il légal ? Exporté car tout consommateur d'un nom
 * venu du réseau (le bundle de pull, une route qui sert un fichier) doit pouvoir
 * le vérifier AVANT de construire un chemin avec — un `../db.sqlite` ne doit
 * jamais atteindre un writeFile/sendFile.
 */
export function isValidAssetFilename(filename) {
  return typeof filename === 'string' && ASSET_FILENAME_RE.test(filename);
}

const fail = (error) => ({ ok: false, error });

// Factorise la validation d'un objet colors (racine ou surcharge par écran,
// design3) : même règle des deux côtés — clé inconnue rejetée, valeur hex
// stricte, clé manquante autorisée (fallback). `label` sert uniquement au
// message d'erreur (ex. 'colors' ou 'screenOverrides.start.colors').
function validateColorsObject(colors, label) {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    return `${label} doit être un objet.`;
  }
  for (const key of Object.keys(colors)) {
    if (!DESIGN_COLOR_KEYS.includes(key)) {
      return `Clé de couleur inconnue dans ${label} : ${key}.`;
    }
  }
  for (const key of DESIGN_COLOR_KEYS) {
    const value = colors[key];
    if (value === undefined) continue; // clé manquante autorisée → fallback
    if (typeof value !== 'string' || !HEX_RE.test(value)) {
      return `${label}.${key} doit être une couleur hexadécimale (#rrggbb ou #rrggbbaa).`;
    }
  }
  return null;
}

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
    const error = validateColorsObject(obj.colors, 'colors');
    if (error) return fail(error);
  }

  // ── radius / font ─────────────────────────────────────────────────────────
  if (obj.radius !== undefined && !DESIGN_RADIUS.includes(obj.radius)) {
    return fail(`radius doit valoir ${DESIGN_RADIUS.join(', ')}.`);
  }
  if (obj.font !== undefined && !DESIGN_FONTS.includes(obj.font)) {
    return fail(`font doit valoir ${DESIGN_FONTS.join(', ')}.`);
  }

  // ── images ────────────────────────────────────────────────────────────────
  // Une seule image par écran (design4), 3 états exacts : { mode, filename,
  // widthPercent? }. Même pattern que screenOverrides/colors : whitelist des
  // écrans reçus contre DESIGN_IMAGE_SCREENS, puis whitelist stricte des clés
  // à l'intérieur — jamais itéré sur les clés reçues pour les copier (barrière
  // anti-injection).
  if (obj.images !== undefined) {
    const images = obj.images;
    if (!images || typeof images !== 'object' || Array.isArray(images)) {
      return fail('images doit être un objet.');
    }
    for (const key of Object.keys(images)) {
      if (!DESIGN_IMAGE_SCREENS.includes(key)) {
        return fail(`Écran d'image inconnu : ${key}.`);
      }
    }
    for (const screen of DESIGN_IMAGE_SCREENS) {
      const entry = images[screen];
      if (entry === undefined) continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return fail(`images.${screen} doit être un objet.`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'mode' && key !== 'filename' && key !== 'widthPercent') {
          return fail(`Clé d'image inconnue dans images.${screen} : ${key}.`);
        }
      }
      if (!DESIGN_IMAGE_MODES.includes(entry.mode)) {
        return fail(`images.${screen}.mode doit valoir ${DESIGN_IMAGE_MODES.join(', ')}.`);
      }
      // Cohérence mode/filename : 'none' n'a jamais de fichier ; tout autre
      // mode EXIGE un fichier valide — empêche l'état incohérent "plein écran
      // sans image" qui laisserait le kiosque sans rien à afficher.
      if (entry.mode === 'none') {
        if (entry.filename !== null && entry.filename !== undefined) {
          return fail(`images.${screen}.filename doit être null quand mode vaut 'none'.`);
        }
      } else if (typeof entry.filename !== 'string' || !ASSET_FILENAME_RE.test(entry.filename)) {
        return fail(`images.${screen}.filename doit être un nom de fichier <uuid>.png|jpg|webp.`);
      }
      // widthPercent (design5) : premier champ numérique du contrat. Reste
      // sûr au même titre qu'une enum — borné, entier strict, jamais
      // interprété comme du CSS libre (consommé uniquement comme `<n>%` d'un
      // width/max-width, jamais concaténé dans url()/expression()). N'a de
      // sens qu'en mode 'centered' : 'cover' occupe déjà tout l'écran, 'none'
      // n'a pas d'image.
      if (entry.widthPercent !== undefined) {
        if (entry.mode !== 'centered') {
          return fail(`images.${screen}.widthPercent n'est permis qu'en mode 'centered'.`);
        }
        if (
          !Number.isInteger(entry.widthPercent)
          || entry.widthPercent < DESIGN_IMAGE_WIDTH_MIN
          || entry.widthPercent > DESIGN_IMAGE_WIDTH_MAX
        ) {
          return fail(`images.${screen}.widthPercent doit être un entier entre ${DESIGN_IMAGE_WIDTH_MIN} et ${DESIGN_IMAGE_WIDTH_MAX}.`);
        }
      }
    }
  }

  // ── screenOverrides ──────────────────────────────────────────────────────
  // Surcharge de couleurs par écran (design3). Même pattern que layouts : on
  // whitelist les écrans reçus contre DESIGN_SCREENS, puis on valide chaque
  // sous-objet colors avec la MÊME fonction que colors racine (validateColorsObject) —
  // pas de logique dupliquée qui pourrait diverger.
  if (obj.screenOverrides !== undefined) {
    const overrides = obj.screenOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return fail('screenOverrides doit être un objet.');
    }
    for (const key of Object.keys(overrides)) {
      if (!DESIGN_SCREENS.includes(key)) {
        return fail(`Écran de surcharge inconnu : ${key}.`);
      }
    }
    for (const screen of DESIGN_SCREENS) {
      const entry = overrides[screen];
      if (entry === undefined) continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return fail(`screenOverrides.${screen} doit être un objet.`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'colors') {
          return fail(`Clé de surcharge inconnue dans screenOverrides.${screen} : ${key}.`);
        }
      }
      if (entry.colors !== undefined) {
        const error = validateColorsObject(entry.colors, `screenOverrides.${screen}.colors`);
        if (error) return fail(error);
      }
    }
  }

  return { ok: true };
}

/**
 * Résout les 18 couleurs effectives d'un écran donné : surcharge de cet écran
 * si présente (design3), sinon valeur globale (`colors`). Source unique de
 * vérité utilisée par le runtime kiosque (apps/borne/web) ET l'éditeur Hub
 * (aperçu live) — aucun des deux ne doit recalculer cette logique à la main,
 * sous peine de divergence entre ce que le client voit et ce que la borne rend.
 *
 * Itère uniquement sur DESIGN_COLOR_KEYS (jamais sur les clés reçues) — même
 * barrière anti-injection que validateDesign, même si l'entrée est déjà censée
 * avoir été validée en amont : une fonction exportée doit être sûre seule.
 *
 * @param {unknown} config objet design (potentiellement invalide/partiel)
 * @param {string} screen un des DESIGN_SCREENS ; toute autre valeur retombe
 *   silencieusement sur les couleurs globales (pas de surcharge trouvée)
 * @returns {Record<string, string>} objet { [colorKey]: hexValue }, clés
 *   manquantes omises (même contrat que `colors` : absence = fallback thème)
 */
export function resolveScreenColors(config, screen) {
  const override = config?.screenOverrides?.[screen]?.colors;
  const resolved = {};
  for (const key of DESIGN_COLOR_KEYS) {
    const value = override?.[key] !== undefined ? override[key] : config?.colors?.[key];
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}
