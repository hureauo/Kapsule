import React, { useState, useEffect, useRef } from 'react';
import {
  DESIGN_COLOR_KEYS, DESIGN_RADIUS, DESIGN_FONTS, DESIGN_LAYOUTS, DESIGN_ASSET_SLOTS,
  DESIGN_SCREENS, validateDesign, resolveScreenColors,
} from '@kapsule/core';
import { api } from '../../api/client.js';
import DesignPreview from './DesignPreview.jsx';

// Éditeur de tokens (§9bis). Aucune saisie CSS libre : couleurs par <input
// type="color"> natif (stack figée — pas de bibliothèque de color picker) et
// enums par <select>/radios. Le backend revalide de toute façon (validateDesign).

const COLOR_LABELS = {
  bg: 'Fond',
  surface: 'Surface (cartes, barres)',
  'surface-alt': 'Surface secondaire',
  text: 'Texte',
  'text-muted': 'Texte discret',
  'text-error': 'Texte d\'erreur',
  primary: 'Couleur principale',
  'primary-soft': 'Principale — douce',
  'primary-tint': 'Principale — voile',
  accent: 'Couleur d\'action',
  'accent-hover': 'Action — survol',
  'accent-soft': 'Action — douce',
  'accent-tint': 'Action — voile',
  'input-bg': 'Fond des champs',
  'input-border': 'Bordure des champs',
  'input-border-focus': 'Bordure des champs (focus)',
  'btn-secondary-bg': 'Bouton secondaire',
  'btn-secondary-hover': 'Bouton secondaire — survol',
};

// primary-soft et accent-tint restent dans le contrat (DESIGN_COLOR_KEYS,
// packages/core) mais ne sont consommées par AUCUNE règle CSS du kiosque réel
// (apps/borne/web/src/styles/app.css) — les masquer évite de faire croire au
// client qu'elles ont un effet visible. Si un futur usage borne les consomme,
// il suffira de retirer ces deux clés d'ici (contrat/validation inchangés,
// rien à migrer côté designs déjà enregistrés).
const HIDDEN_COLOR_KEYS = ['primary-soft', 'accent-tint'];
const VISIBLE_COLOR_KEYS = DESIGN_COLOR_KEYS.filter((k) => !HIDDEN_COLOR_KEYS.includes(k));

// Couplage maquette (design2.D) : quel écran de DesignPreview afficher et quel
// élément faire pulser au survol d'une ligne de couleur. Documenté ici car
// DesignPreview (data-color-target) et cette table doivent rester synchrones —
// un couple {screen, key} sans data-color-target correspondant ne pulsera
// simplement rien (dégradation silencieuse, pas une erreur).
const COLOR_TARGET = {
  bg: { screen: 'start', key: 'bg' },
  surface: { screen: 'name', key: 'surface' },
  'surface-alt': { screen: 'recording', key: 'surface-alt' },
  text: { screen: 'start', key: 'text' },
  'text-muted': { screen: 'start', key: 'text-muted' },
  'text-error': { screen: 'recording', key: 'text-error' },
  primary: { screen: 'recording', key: 'primary' },
  'primary-tint': { screen: 'recording', key: 'primary-tint' },
  accent: { screen: 'start', key: 'accent' },
  'accent-hover': { screen: 'name', key: 'accent-hover' },
  'accent-soft': { screen: 'recording', key: 'accent-soft' },
  'input-bg': { screen: 'name', key: 'input-bg' },
  'input-border': { screen: 'name', key: 'input-border' },
  'input-border-focus': { screen: 'name', key: 'input-border' },
  'btn-secondary-bg': { screen: 'thanks', key: 'btn-secondary-bg' },
  // btn-secondary-hover pointe vers le MÊME data-color-target que
  // btn-secondary-bg (key: 'btn-secondary-bg', pas 'btn-secondary-hover') : il
  // n'existe qu'un seul bouton secondaire dans la maquette NameScreen, donc pas
  // de second data-color-target possible sans dupliquer visuellement le bouton.
  // Limite assumée : le highlight pulse le bon bouton, mais la maquette statique
  // n'affiche jamais réellement --btn-secondary-hover (pas d'état :hover simulé
  // en CSS) — contrairement à accent/accent-hover qui ont chacun leur propre
  // bouton (Commencer / Continuer) et donc leur propre data-color-target.
  'btn-secondary-hover': { screen: 'name', key: 'btn-secondary-bg' },
};

// Regroupement des couleurs par écran (au lieu de l'ordre technique de
// DESIGN_COLOR_KEYS) : on clique une couleur, on veut la voir dans l'écran où
// elle apparaît sans avoir à re-switcher — donc les couleurs d'un même écran
// sont voisines dans le formulaire. Dérivé de COLOR_TARGET (même source que le
// couplage maquette), pas dupliqué à la main.
//
// 4 écrans (design3, DESIGN_SCREENS de @kapsule/core) : 'thanks' manquait ici
// avant design3 (bug préexistant — aucune couleur n'y pointait dans
// COLOR_TARGET, donc le groupe n'apparaissait jamais). btn-secondary-bg pointe
// maintenant vers 'thanks' (bouton « Retour à l'accueil » de la maquette
// ThanksScreen, qui porte bien data-color-target="btn-secondary-bg").
const SCREEN_LABELS = {
  start: 'Écran d\'accueil',
  name: 'Écran « Prénom »',
  recording: 'Écran d\'enregistrement',
  thanks: 'Écran de remerciement',
};
const SCREEN_ORDER = ['start', 'name', 'recording', 'thanks'];

function groupColorsByScreen() {
  const groups = new Map(SCREEN_ORDER.map((s) => [s, []]));
  for (const key of VISIBLE_COLOR_KEYS) {
    const screen = COLOR_TARGET[key]?.screen ?? 'start';
    if (!groups.has(screen)) groups.set(screen, []);
    groups.get(screen).push(key);
  }
  return [...groups.entries()].filter(([, keys]) => keys.length > 0);
}

const RADIUS_LABELS = { sharp: 'Anguleux', soft: 'Doux', round: 'Très arrondi' };
const FONT_LABELS = {
  sans: 'Sans serif',
  serif: 'Serif',
  rounded: 'Arrondie',
  mono: 'Monospace',
  humanist: 'Humaniste',
  grotesk: 'Grotesque',
  slab: 'Slab serif',
  elegant: 'Élégante',
};
const LAYOUT_LABELS = {
  centered: 'Centré',
  cover: 'Image plein écran',
  split: 'Deux colonnes',
};

// <input type="color"> ne connaît pas le canal alpha : on ne lui montre que les
// 6 premiers hex, et on laisse le champ texte pour saisir un #rrggbbaa complet.
const toPickerValue = (hex) => (typeof hex === 'string' ? hex.slice(0, 7) : '#000000');

const STATUS_LABELS = {
  preview: 'préparation',
  ready: 'prêt',
  loaded: 'chargé',
  live: 'en direct',
  closed: 'clos',
  pushed: 'transféré',
  processed: 'traité',
  waiting: 'en attente',
};

export default function DesignEditor({ design, readOnly, onSaved, onError, onDuplicate }) {
  const [config, setConfig] = useState(design.config);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState('');
  const [usage, setUsage] = useState([]);
  // Sélection au clic (plutôt qu'au survol) : reste affichée tant qu'on ne
  // clique pas une autre ligne, pour laisser le temps de regarder l'aperçu
  // sans avoir à garder la souris immobile dessus.
  const [activeColorKey, setActiveColorKey] = useState(null);
  // Onglet actif du fieldset Couleurs (design3) : 'global' ou un des DESIGN_SCREENS.
  const [activeScreenTab, setActiveScreenTab] = useState('global');

  // Changer de design sélectionné réinitialise le formulaire.
  useEffect(() => {
    setConfig(design.config);
    setDirty(false);
    setInvalid('');
  }, [design.id, design.config]);

  // Avertissement d'usage (design2.C, §9bis) : informatif, non bloquant — pas
  // d'erreur affichée si l'appel échoue, ce n'est qu'un bandeau d'aide.
  useEffect(() => {
    let cancelled = false;
    api.designUsage(design.id)
      .then((rows) => { if (!cancelled) setUsage(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [design.id]);

  function update(patch) {
    const next = { ...config, ...patch };
    setConfig(next);
    setDirty(true);
    // Retour immédiat : on valide côté client avec la MÊME fonction que le
    // backend (core), donc aucun écart de règle possible.
    const check = validateDesign(next);
    setInvalid(check.ok ? '' : check.error);
  }

  const setColor = (key, value) => update({ colors: { ...config.colors, [key]: value } });
  const setLayout = (screen, value) => update({ layouts: { ...config.layouts, [screen]: value } });

  // Surcharge/re-héritage d'une couleur pour UN écran (design3). Même fonction
  // update() que le reste : revalidation immédiate côté client (validateDesign).
  function setScreenColor(screen, key, value) {
    update({
      screenOverrides: {
        ...config.screenOverrides,
        [screen]: {
          ...config.screenOverrides?.[screen],
          colors: { ...config.screenOverrides?.[screen]?.colors, [key]: value },
        },
      },
    });
  }

  // Re-hériter : retire la clé du sous-objet (delete explicite, pas de valeur
  // undefined qui laisserait planer une ambiguïté dans le state React entre
  // « explicitement absente » et « jamais définie »). Si l'écran n'a plus AUCUNE
  // couleur surchargée, on retire aussi son entrée (pas de { colors: {} } qui
  // traînerait indéfiniment dans le JSON persisté — juste du bruit, inoffensif
  // pour resolveScreenColors, mais autant garder la config propre).
  function unsetScreenColor(screen, key) {
    const nextColors = { ...config.screenOverrides?.[screen]?.colors };
    delete nextColors[key];

    const nextOverrides = { ...config.screenOverrides };
    if (Object.keys(nextColors).length === 0) {
      delete nextOverrides[screen];
    } else {
      nextOverrides[screen] = { ...config.screenOverrides?.[screen], colors: nextColors };
    }

    update({ screenOverrides: nextOverrides });
  }

  async function handleSave() {
    setSaving(true);
    const previous = design.config;
    try {
      await api.updateDesign(design.id, { config });
      setDirty(false);
      await onSaved?.();
    } catch (err) {
      // Rollback : on remet la config connue du serveur.
      setConfig(previous);
      setDirty(false);
      onError?.(err.message);
    } finally {
      setSaving(false);
    }
  }

  const previewCount = usage.filter((u) => u.status === 'preview').length;
  const otherCount = usage.length - previewCount;

  // Dans l'onglet Global, le highlight suit la table statique COLOR_TARGET
  // (comportement design2.D inchangé) : rien tant qu'aucune couleur n'est
  // cliquée. Dans un onglet écran, l'aperçu bascule TOUJOURS sur cet écran dès
  // qu'on y entre (cohérence avec ce qui est en cours d'édition), même sans
  // avoir encore cliqué une couleur — la clé de pulsation reste vide dans ce
  // cas (juste la bascule d'écran, pas de highlight tant que rien n'est cliqué).
  const hoverTarget = activeScreenTab === 'global'
    ? (activeColorKey ? COLOR_TARGET[activeColorKey] : null)
    : { screen: activeScreenTab, key: activeColorKey };

  // Couleurs résolues de l'onglet écran actif (design3) — calculé une fois par
  // rendu, réutilisé pour chaque ligne de couleur du fieldset (pas de nouvel
  // appel resolveScreenColors par ligne).
  const resolvedScreenColors = activeScreenTab !== 'global'
    ? resolveScreenColors(config, activeScreenTab)
    : null;

  return (
    <div className="designs-editor">
      <div className="designs-editor__form">
        {usage.length > 0 && (
          <div className="designs-usage-banner">
            <p>
              Utilisé sur {usage.length} événement{usage.length > 1 ? 's' : ''}.{' '}
              {previewCount > 0 && (
                <>Les événements en préparation ({previewCount}) seront mis à jour automatiquement. </>
              )}
              {otherCount > 0 && (
                <>Les autres ({otherCount}) gardent leur version actuelle (copie figée).</>
              )}
            </p>
            <ul className="designs-usage-banner__list">
              {usage.map((u) => (
                <li key={u.event_id}>
                  {u.name} — <span className="text--muted">{STATUS_LABELS[u.status] ?? u.status}</span>
                </li>
              ))}
            </ul>
            {onDuplicate && (
              <button className="btn btn--sm btn--ghost" onClick={onDuplicate}>
                Dupliquer ce design
              </button>
            )}
          </div>
        )}

        {!readOnly && (
          <div className="designs-editor__actions">
            <button
              className="btn btn--primary"
              onClick={handleSave}
              disabled={saving || !dirty || !!invalid}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {dirty && !invalid && <span className="text--muted">Modifications non enregistrées</span>}
            {invalid && <span className="error-msg">{invalid}</span>}
          </div>
        )}

        <fieldset className="designs-fieldset" disabled={readOnly}>
          <legend className="designs-fieldset__legend">Couleurs</legend>

          {/* Onglets écran (design3) : Global édite colors (racine, hérité par tous
              les écrans sans surcharge) ; chaque écran édite screenOverrides.<screen>. */}
          <div className="designs-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeScreenTab === 'global'}
              className={`btn btn--sm ${activeScreenTab === 'global' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setActiveScreenTab('global')}
            >
              Global
            </button>
            {DESIGN_SCREENS.map((screen) => (
              <button
                type="button"
                role="tab"
                key={screen}
                aria-selected={activeScreenTab === screen}
                className={`btn btn--sm ${activeScreenTab === screen ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => {
                  setActiveScreenTab(screen);
                  // Changer d'onglet écran doit aussi montrer CET écran dans
                  // l'aperçu (cohérence : « j'édite l'accueil, je regarde
                  // l'accueil »), même sans avoir encore cliqué une couleur.
                  setActiveColorKey(null);
                }}
              >
                {SCREEN_LABELS[screen]}
              </button>
            ))}
          </div>

          {activeScreenTab === 'global' ? (
            <>
              <p className="text--muted designs-hint">
                Cliquez une couleur pour l'afficher dans l'aperçu.
              </p>
              {groupColorsByScreen().map(([screen, keys]) => (
                <div className="designs-color-group" key={screen}>
                  <p className="designs-color-group__title">{SCREEN_LABELS[screen] ?? screen}</p>
                  {keys.map((key) => (
                    // Pas de <button> ici : un bouton ne peut pas contenir <input>
                    // (contenu interactif imbriqué invalide — le navigateur ferme
                    // la balise prématurément). role="button" reproduit la
                    // sémantique clic/clavier sans ce problème.
                    <div
                      role="button"
                      tabIndex={0}
                      className={`designs-color-row ${activeColorKey === key ? 'designs-color-row--active' : ''}`}
                      key={key}
                      onClick={() => setActiveColorKey(key)}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          setActiveColorKey(key);
                        }
                      }}
                    >
                      <span className="designs-color-row__cue" aria-hidden="true">👁</span>
                      <label className="designs-color-row__label" htmlFor={`color-${key}`}>
                        {COLOR_LABELS[key]}
                      </label>
                      <input
                        id={`color-${key}`}
                        type="color"
                        className="designs-color-picker"
                        value={toPickerValue(config.colors?.[key])}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={() => setActiveColorKey(key)}
                        onChange={(e) => setColor(key, e.target.value)}
                      />
                      <input
                        type="text"
                        className="hub-input designs-color-hex"
                        value={config.colors?.[key] ?? ''}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={() => setActiveColorKey(key)}
                        onChange={(e) => setColor(key, e.target.value)}
                        placeholder="#rrggbb"
                        spellCheck="false"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </>
          ) : (
            <>
              <p className="text--muted designs-hint">
                Couleurs de l'écran « {SCREEN_LABELS[activeScreenTab]} ». Une couleur non
                détachée hérite de sa valeur globale.
              </p>
              {VISIBLE_COLOR_KEYS.map((key) => {
                const overrideValue = config.screenOverrides?.[activeScreenTab]?.colors?.[key];
                const isOverridden = overrideValue !== undefined;
                const resolvedValue = resolvedScreenColors?.[key];
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    className={`designs-color-row designs-color-row--screen ${activeColorKey === key ? 'designs-color-row--active' : ''}`}
                    key={key}
                    onClick={() => setActiveColorKey(key)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        setActiveColorKey(key);
                      }
                    }}
                  >
                    <span className="designs-color-row__cue" aria-hidden="true">👁</span>
                    <label className="designs-color-row__label" htmlFor={`screen-color-${activeScreenTab}-${key}`}>
                      {COLOR_LABELS[key]}
                    </label>
                    {isOverridden ? (
                      <>
                        <input
                          id={`screen-color-${activeScreenTab}-${key}`}
                          type="color"
                          className="designs-color-picker"
                          value={toPickerValue(overrideValue)}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={() => setActiveColorKey(key)}
                          onChange={(e) => setScreenColor(activeScreenTab, key, e.target.value)}
                        />
                        <input
                          type="text"
                          className="hub-input designs-color-hex"
                          value={overrideValue}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={() => setActiveColorKey(key)}
                          onChange={(e) => setScreenColor(activeScreenTab, key, e.target.value)}
                          placeholder="#rrggbb"
                          spellCheck="false"
                        />
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={(e) => { e.stopPropagation(); unsetScreenColor(activeScreenTab, key); }}
                        >
                          Re-hériter
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="designs-badge designs-badge--inherit">
                          Hérite {resolvedValue ? `(${resolvedValue})` : ''}
                        </span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setScreenColor(activeScreenTab, key, resolvedValue ?? '#000000');
                          }}
                        >
                          Détacher
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </fieldset>

        <fieldset className="designs-fieldset" disabled={readOnly}>
          <legend className="designs-fieldset__legend">Formes et typographie</legend>

          <label className="field-label">
            Arrondi des angles
            <select
              className="hub-input"
              value={config.radius ?? 'soft'}
              onChange={(e) => update({ radius: e.target.value })}
            >
              {DESIGN_RADIUS.map((r) => (
                <option key={r} value={r}>{RADIUS_LABELS[r]}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Police
            <select
              className="hub-input"
              value={config.font ?? 'sans'}
              onChange={(e) => update({ font: e.target.value })}
            >
              {DESIGN_FONTS.map((f) => (
                <option key={f} value={f}>{FONT_LABELS[f]}</option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className="designs-fieldset" disabled={readOnly}>
          <legend className="designs-fieldset__legend">Images</legend>
          {DESIGN_ASSET_SLOTS.map((slot) => (
            <AssetRow
              key={slot}
              slot={slot}
              designId={design.id}
              filename={config.assets?.[slot] ?? null}
              readOnly={readOnly}
              onChanged={onSaved}
              onError={onError}
            />
          ))}
          <p className="text--muted designs-hint">
            PNG, JPEG ou WebP, 2 Mo maximum. Le fond n'est visible que sur les dispositions
            « Image plein écran ».
          </p>
        </fieldset>

        <fieldset className="designs-fieldset" disabled={readOnly}>
          <legend className="designs-fieldset__legend">Dispositions</legend>
          {Object.entries(DESIGN_LAYOUTS).map(([screen, options]) => (
            <div className="designs-layout-row" key={screen}>
              <span className="designs-layout-row__label">
                {screen === 'start' ? 'Écran d\'accueil' : 'Écran de remerciement'}
              </span>
              <div className="designs-layout-row__options">
                {options.map((opt) => (
                  <label key={opt} className="designs-radio">
                    <input
                      type="radio"
                      name={`layout-${screen}`}
                      value={opt}
                      checked={(config.layouts?.[screen] ?? 'centered') === opt}
                      onChange={() => setLayout(screen, opt)}
                    />
                    {LAYOUT_LABELS[opt]}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      </div>

      <div className="designs-editor__preview">
        <DesignPreview config={config} hoverTarget={hoverTarget} designId={design.id} />
      </div>
    </div>
  );
}

const SLOT_LABELS = { logo: 'Logo', background: 'Image de fond' };

// Upload d'une image. L'upload est immédiat (il crée sa propre version côté
// serveur) — contrairement aux tokens, il n'attend pas le bouton « Enregistrer ».
function AssetRow({ slot, designId, filename, readOnly, onChanged, onError }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadDesignAsset(designId, slot, file);
      await onChanged?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = ''; // permet de re-choisir le même fichier
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await api.deleteDesignAsset(designId, slot);
      await onChanged?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="designs-asset-row">
      <span className="designs-asset-row__label">{SLOT_LABELS[slot]}</span>

      {filename ? (
        <img
          className="designs-asset-row__preview"
          src={api.designAssetUrl(designId, filename)}
          alt={SLOT_LABELS[slot]}
        />
      ) : (
        <span className="designs-asset-row__empty">Aucune image</span>
      )}

      {!readOnly && (
        <div className="designs-asset-row__actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFile}
            disabled={busy}
            className="designs-asset-row__input"
          />
          {filename && (
            <button className="btn btn--sm btn--ghost" onClick={handleRemove} disabled={busy}>
              Retirer
            </button>
          )}
        </div>
      )}
    </div>
  );
}
