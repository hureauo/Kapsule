import React, { useState, useEffect } from 'react';
import {
  DESIGN_COLOR_KEYS, DESIGN_RADIUS, DESIGN_FONTS, DESIGN_LAYOUTS, validateDesign,
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

const RADIUS_LABELS = { sharp: 'Anguleux', soft: 'Doux', round: 'Très arrondi' };
const FONT_LABELS = { sans: 'Sans serif', serif: 'Serif', rounded: 'Arrondie', mono: 'Monospace' };
const LAYOUT_LABELS = {
  centered: 'Centré',
  cover: 'Image plein écran',
  split: 'Deux colonnes',
};

// <input type="color"> ne connaît pas le canal alpha : on ne lui montre que les
// 6 premiers hex, et on laisse le champ texte pour saisir un #rrggbbaa complet.
const toPickerValue = (hex) => (typeof hex === 'string' ? hex.slice(0, 7) : '#000000');

export default function DesignEditor({ design, readOnly, onSaved, onError }) {
  const [config, setConfig] = useState(design.config);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState('');

  // Changer de design sélectionné réinitialise le formulaire.
  useEffect(() => {
    setConfig(design.config);
    setDirty(false);
    setInvalid('');
  }, [design.id, design.config]);

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

  return (
    <div className="designs-editor">
      <div className="designs-editor__form">
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
            <div className="designs-color-row" key={key}>
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
        <DesignPreview config={config} />
      </div>
    </div>
  );
}
