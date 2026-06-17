import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { TEXT_FIELDS } from '@kapsule/core';

const THEME_OPTIONS = [
  { value: 'cute',   label: '🫧 Cutealism', hint: 'Doux, coloré, rassurant (défaut)' },
  { value: 'modern', label: '⬜ Modern',    hint: 'Blanc épuré, plat, léger' },
  { value: 'dark',   label: '🎬 Sombre',    hint: 'Noir / rouge, sobre' },
];

const TEXT_FIELD_LABELS = {
  welcome_title:    'Titre d\'accueil',
  welcome_subtitle: 'Sous-titre d\'accueil',
  name_prompt:      'Invite prénom',
  consent_text:     'Texte de consentement',
  consent_details:  'Détails (« En savoir plus »)',
  thanks_text:      'Message de remerciement',
};

export default function DesignPanel() {
  const [activeEvent, setActiveEvent] = useState(null);
  const [theme, setTheme] = useState(null);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeError, setThemeError] = useState('');
  const [texts, setTexts] = useState({});
  const [textsSaving, setTextsSaving] = useState(false);
  const [textsError, setTextsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const evt = await api.getEvent();
      setActiveEvent(evt);
      setTheme(evt.theme ?? 'cute');
      const initialTexts = {};
      for (const key of Object.keys(TEXT_FIELDS)) {
        initialTexts[key] = evt[key] ?? '';
      }
      setTexts(initialTexts);
    } catch (e) {
      if (e.status === 404) {
        setError('Aucun événement actif. Activez un événement depuis l\'onglet Événement.');
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSelectTheme(value) {
    if (!activeEvent || value === theme) return;
    const previous = theme;
    setTheme(value);
    setThemeSaving(true);
    setThemeError('');
    try {
      const res = await api.updateEventSettings(activeEvent.id, { theme: value });
      setTheme(res.theme);
    } catch (err) {
      setTheme(previous);
      setThemeError(err.message);
    } finally {
      setThemeSaving(false);
    }
  }

  async function handleSaveTexts() {
    if (!activeEvent) return;
    const previous = { ...texts };
    setTextsSaving(true);
    setTextsError('');
    try {
      const res = await api.updateEventSettings(activeEvent.id, texts);
      const updated = {};
      for (const key of Object.keys(TEXT_FIELDS)) {
        updated[key] = res[key] ?? '';
      }
      setTexts(updated);
    } catch (err) {
      setTexts(previous);
      setTextsError(err.message);
    } finally {
      setTextsSaving(false);
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;
  if (error) return (
    <p className="text--error">
      {error}{' '}
      <button className="btn btn--small btn--secondary" onClick={load}>Réessayer</button>
    </p>
  );

  return (
    <div className="design-panel">
      <section className="panel-section">
        <h2 className="panel-section__title">
          Thème visuel
          <span className="panel-section__hint"> — vu par les invités</span>
        </h2>
        <div className="theme-picker">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-option${theme === opt.value ? ' theme-option--active' : ''}`}
              onClick={() => handleSelectTheme(opt.value)}
              disabled={themeSaving}
              aria-pressed={theme === opt.value}
            >
              <span className="theme-option__label">{opt.label}</span>
              <span className="theme-option__hint">{opt.hint}</span>
            </button>
          ))}
        </div>
        {themeError && <p className="text--error">{themeError}</p>}
      </section>

      <section className="panel-section">
        <h2 className="panel-section__title">
          Textes du parcours
          <span className="panel-section__hint"> — affichés aux invités</span>
        </h2>
        {Object.entries(TEXT_FIELD_LABELS).map(([key, label]) => (
          <label key={key} className="question-form__field">
            <span>{label}</span>
            <textarea
              className="admin-input admin-input--textarea"
              value={texts[key] ?? ''}
              onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
              disabled={textsSaving}
              rows={key === 'consent_text' || key === 'consent_details' ? 4 : 2}
            />
          </label>
        ))}
        <div className="question-form__actions" style={{ marginTop: '0.5rem' }}>
          <button
            className="btn btn--small btn--primary"
            onClick={handleSaveTexts}
            disabled={textsSaving}
          >
            {textsSaving ? 'Enregistrement…' : 'Enregistrer les textes'}
          </button>
        </div>
        {textsError && <p className="text--error">{textsError}</p>}
      </section>
    </div>
  );
}
