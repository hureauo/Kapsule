// Maquettes de démonstration — risque de dérive assumé, la borne d'essai reste la validation finale.
//
// Ces écrans IMITENT le kiosque (mêmes tokens, mêmes formes) mais ne partagent
// aucun code avec la borne : le but est de donner un retour immédiat au client
// pendant qu'il règle ses couleurs, pas de garantir un rendu au pixel près.
// Les presets (rayons, polices) viennent de @kapsule/core — même source que le
// runtime kiosque, donc pas de dérive possible sur CES valeurs-là.

import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { DESIGN_COLOR_KEYS, RADIUS_PRESETS, FONT_PRESETS, resolveScreenColors } from '@kapsule/core';

const WIDTHS = [
  { key: 'mobile', label: 'Mobile', width: 360 },
  { key: 'ipad', label: 'iPad', width: 820 },
  { key: 'desktop', label: 'Desktop', width: 1280 },
];

// Construit les custom properties à partir de la config, résolues pour l'écran
// affiché (design3 : screenOverrides > colors globales > absent). Whitelist
// stricte déjà portée par resolveScreenColors (core) — source unique partagée
// avec le runtime kiosque, pas de recalcul divergent ici.
function cssVarsFor(config, screen) {
  const vars = {};
  const colors = resolveScreenColors(config, screen);
  for (const key of DESIGN_COLOR_KEYS) {
    if (colors[key]) vars[`--${key}`] = colors[key];
  }
  const radius = RADIUS_PRESETS[config?.radius] ?? RADIUS_PRESETS.soft;
  vars['--radius'] = radius.radius;
  vars['--radius-pill'] = radius.pill;
  vars['--font-body'] = FONT_PRESETS[config?.font] ?? FONT_PRESETS.sans;
  return vars;
}

// hoverTarget vient de COLOR_TARGET (DesignEditor, design2.D) : { screen, key }.
// Posé au CLIC sur une ligne couleur (plus fiable qu'un hover : reste affiché
// le temps de regarder l'aperçu). Bascule l'aperçu sur l'écran concerné et
// fait pulser l'élément marqué data-color-target={key} (animation CSS .dp-pulse).
export default function DesignPreview({ config, hoverTarget = null }) {
  const [widthKey, setWidthKey] = useState('ipad');
  const [screen, setScreen] = useState('start');
  const viewportRef = useRef(null);
  const previewRef = useRef(null);
  const [scale, setScale] = useState(1);

  // Chaque clic bascule l'écran automatiquement ; changer de ligne cliquée
  // vers un autre écran re-bascule, mais rien ne revient en arrière tout seul.
  useEffect(() => {
    if (hoverTarget?.screen) setScreen(hoverTarget.screen);
  }, [hoverTarget?.screen]);

  const target = WIDTHS.find((w) => w.key === widthKey) ?? WIDTHS[1];
  const vars = cssVarsFor(config, screen);
  const pulseKey = hoverTarget?.screen === screen ? hoverTarget.key : null;

  // Pose/retire la classe de pulsation sur l'élément marqué data-color-target
  // dans LA MAQUETTE COURANTE (pas de re-render de chaque écran juste pour ça).
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return undefined;
    if (!pulseKey) return undefined;
    const el = root.querySelector(`[data-color-target="${pulseKey}"]`);
    if (!el) return undefined;
    el.classList.add('dp-pulse');
    return () => el.classList.remove('dp-pulse');
  }, [pulseKey, screen, config]);

  // Le facteur de réduction est MESURÉ sur le conteneur (ResizeObserver) plutôt
  // que deviné en CSS : la colonne de l'aperçu change de largeur avec la fenêtre
  // et la mise en page (aperçu épinglé à droite sur desktop).
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const update = () => setScale(Math.min(1, el.clientWidth / target.width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [target.width]);

  // La transform ne change pas la hauteur de layout : sans hauteur explicite,
  // un grand vide subsisterait sous l'aperçu réduit. 3/4 = aspect-ratio 4/3
  // du .design-preview (voir app.css).
  const scaledHeight = Math.round(target.width * (3 / 4) * scale);

  return (
    <div className="designs-preview">
      <div className="designs-preview__toolbar">
        <div className="designs-preview__group">
          {WIDTHS.map((w) => (
            <button
              key={w.key}
              className={`btn btn--sm ${widthKey === w.key ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setWidthKey(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="designs-preview__group">
          {[
            ['start', 'Accueil'],
            ['name', 'Prénom'],
            ['recording', 'Enregistrement'],
            ['thanks', 'Merci'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`btn btn--sm ${screen === key ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setScreen(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Le cadre a la largeur cible réelle (360/820/1280) et est réduit par
          transform pour tenir dans la colonne : c'est ce qui rend la bascule
          mobile/iPad/desktop honnête. */}
      <div className="designs-preview__viewport" ref={viewportRef} style={{ height: scaledHeight }}>
        <div
          className="designs-preview__scaler"
          style={{ width: target.width, transform: `scale(${scale})` }}
        >
          <div className="design-preview" style={vars} ref={previewRef}>
            <Screen screen={screen} config={config} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Screen({ screen, config }) {
  if (screen === 'name') return <NameScreen />;
  if (screen === 'recording') return <RecordingScreen />;
  if (screen === 'thanks') return <ThanksScreen config={config} />;
  return <StartScreen config={config} />;
}

function StartScreen({ config }) {
  const layout = config?.layouts?.start ?? 'centered';

  return (
    <div className={`dp-screen dp-start dp-start--${layout}`} data-color-target="bg">
      {layout === 'split' ? (
        <>
          <div className="dp-start__aside">
            <div className="dp-logo-placeholder">Logo</div>
          </div>
          <div className="dp-start__body">
            <h1 className="dp-title" data-color-target="text">Mariage Léa &amp; Hugo</h1>
            <p className="dp-subtitle" data-color-target="text-muted">Laissez-nous un message vidéo</p>
            <button className="dp-btn dp-btn--accent" data-color-target="accent">Commencer</button>
          </div>
        </>
      ) : (
        <>
          {layout === 'cover' && <div className="dp-cover" data-color-target="surface-alt" />}
          <div className="dp-start__body">
            <div className="dp-logo-placeholder">Logo</div>
            <h1 className="dp-title" data-color-target="text">Mariage Léa &amp; Hugo</h1>
            <p className="dp-subtitle" data-color-target="text-muted">Laissez-nous un message vidéo</p>
            <button className="dp-btn dp-btn--accent" data-color-target="accent">Commencer</button>
          </div>
        </>
      )}
    </div>
  );
}

function NameScreen() {
  return (
    <div className="dp-screen dp-center" data-color-target="surface">
      <h2 className="dp-title">Comment tu t'appelles ?</h2>
      <input className="dp-input" defaultValue="Camille" readOnly data-color-target="input-bg" />
      <div className="dp-consent">
        <span className="dp-checkbox" data-color-target="input-border" />
        <span className="dp-consent__text">
          J'accepte que mes vidéos soient enregistrées et transmises à l'organisateur.
        </span>
      </div>
      <div className="dp-actions">
        <button className="dp-btn dp-btn--secondary" data-color-target="btn-secondary-bg">Retour</button>
        <button className="dp-btn dp-btn--accent" data-color-target="accent-hover">Continuer</button>
      </div>
    </div>
  );
}

function RecordingScreen() {
  return (
    <div className="dp-screen dp-screen--column">
      <div className="dp-center dp-center--grow">
        <p className="dp-muted">Question 2 sur 5</p>
        <h2 className="dp-title dp-title--sm">Quel est ton meilleur souvenir avec eux ?</h2>
        <div className="dp-video" data-color-target="surface-alt">
          <span className="dp-rec" data-color-target="text-error">● REC</span>
          <span className="dp-timer">0:12</span>
        </div>
        <button className="dp-btn dp-btn--accent" data-color-target="primary">■ Stop</button>
      </div>
      {/* Bandeau bas — reproduit QuestionNav.jsx (borne) : barre de remplissage
          + dots + « Question X / N ». Répond aux mêmes tokens que le kiosque réel. */}
      <div className="dp-nav" data-color-target="surface">
        <div className="dp-nav__progress">
          <div className="dp-nav__progress-fill" data-color-target="primary" style={{ width: '40%' }} />
        </div>
        <div className="dp-nav__row">
          <div className="dp-nav__dots">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={[
                  'dp-nav__dot',
                  i === 1 ? 'dp-nav__dot--current' : '',
                  i === 0 ? 'dp-nav__dot--answered' : '',
                ].filter(Boolean).join(' ')}
              />
            ))}
          </div>
          <span className="dp-nav__label">Question 2 / 5</span>
        </div>
      </div>
    </div>
  );
}

function ThanksScreen({ config }) {
  const layout = config?.layouts?.thanks ?? 'centered';
  return (
    <div className={`dp-screen dp-center dp-thanks dp-thanks--${layout}`} data-color-target="bg">
      {layout === 'cover' && <div className="dp-cover" data-color-target="surface-alt" />}
      <div className="dp-start__body">
        <h1 className="dp-title" data-color-target="text">Merci Camille !</h1>
        <p className="dp-subtitle" data-color-target="text-muted">Ton message a bien été enregistré.</p>
        <button className="dp-btn dp-btn--secondary" data-color-target="btn-secondary-bg">Retour à l'accueil</button>
      </div>
    </div>
  );
}
