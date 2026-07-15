import React, { useState, useEffect, useRef } from 'react';
import {
  DESIGN_COLOR_KEYS, DESIGN_RADIUS, DESIGN_FONTS, DESIGN_LAYOUTS, DESIGN_ASSET_SLOTS,
  validateDesign,
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
  'primary-soft': { screen: 'recording', key: 'primary' },
  'primary-tint': { screen: 'recording', key: 'primary' },
  accent: { screen: 'start', key: 'accent' },
  'accent-hover': { screen: 'name', key: 'accent-hover' },
  'accent-soft': { screen: 'start', key: 'accent' },
  'accent-tint': { screen: 'start', key: 'accent' },
  'input-bg': { screen: 'name', key: 'input-bg' },
  'input-border': { screen: 'name', key: 'input-border' },
  'input-border-focus': { screen: 'name', key: 'input-border' },
  'btn-secondary-bg': { screen: 'name', key: 'btn-secondary-bg' },
  'btn-secondary-hover': { screen: 'name', key: 'btn-secondary-bg' },
};

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
  const [hoverColorKey, setHoverColorKey] = useState(null);

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
          {DESIGN_COLOR_KEYS.map((key) => (
            <div
              className="designs-color-row"
              key={key}
              onMouseEnter={() => setHoverColorKey(key)}
              onMouseLeave={() => setHoverColorKey((k) => (k === key ? null : k))}
            >
              <label className="designs-color-row__label" htmlFor={`color-${key}`}>
                {COLOR_LABELS[key]}
              </label>
              <input
                id={`color-${key}`}
                type="color"
                className="designs-color-picker"
                value={toPickerValue(config.colors?.[key])}
                onChange={(e) => setColor(key, e.target.value)}
              />
              <input
                type="text"
                className="hub-input designs-color-hex"
                value={config.colors?.[key] ?? ''}
                onChange={(e) => setColor(key, e.target.value)}
                placeholder="#rrggbb"
                spellCheck="false"
              />
            </div>
          ))}
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
        <DesignPreview config={config} hoverTarget={hoverColorKey ? COLOR_TARGET[hoverColorKey] : null} />
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
