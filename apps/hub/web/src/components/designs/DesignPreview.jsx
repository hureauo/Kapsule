// Aperçu live de l'éditeur — monte les VRAIS écrans du parcours invité
// (@kapsule/guest-ui, chantier designUI), pas une réimplémentation. Un seul
// rendu à maintenir : ce composant ne fait qu'orchestrer (largeur, écran
// affiché, pulsation couleur) et fournir un contenu de démonstration, jamais
// dupliquer le JSX/CSS du kiosque.
//
// Pas d'iframe (la CSP edge bloque X-Frame-Options/frame-ancestors) : les
// composants sont montés directement dans l'arbre React du Hub, à l'intérieur
// d'un wrapper .kapsule-guest qui scope leur CSS partagé et reçoit le design
// en cours d'édition en custom properties INLINE (jamais posées sur
// document.documentElement — aucune pollution du reste du Hub).

import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import {
  StartScreen, NameInput, RecordingScreen, ThankYouScreen, designToVars,
} from '@kapsule/guest-ui';
import { api } from '../../api/client.js';

const WIDTHS = [
  { key: 'mobile', label: 'Mobile', width: 360 },
  { key: 'ipad', label: 'iPad', width: 820 },
  { key: 'desktop', label: 'Desktop', width: 1280 },
];

// Contenu de démonstration — mêmes textes que l'ancienne maquette .dp-*, pour
// ne pas changer l'expérience de calibrage du client entre deux versions.
const DEMO_EVENT = {
  name: 'Kapsule',
  welcome_title: 'Mariage Léa & Hugo',
  welcome_subtitle: 'Laissez-nous un message vidéo',
  name_prompt: 'Comment tu t\'appelles ?',
  consent_text: 'J\'accepte que mes vidéos soient enregistrées et transmises à l\'organisateur.',
};
const DEMO_QUESTION = { text: 'Quel est ton meilleur souvenir avec eux ?', max_duration: 60, countdown: 3 };

const noop = () => {};

// Le formulaire NameInput a un vrai handleSubmit qui appelle createSession —
// en aperçu on ne veut aucun appel réseau ; createSession résout un id
// factice, jamais utilisé (onSession est no-op, personne n'écoute la suite).
async function fakeCreateSession() { return { id: 'preview' }; }

// hoverTarget vient de COLOR_TARGET (DesignEditor) : { screen, key }. Posé au
// CLIC sur une ligne couleur. Bascule l'aperçu sur l'écran concerné et fait
// pulser l'élément marqué data-color-target={key} (animation CSS .dp-pulse,
// seule survivance de l'ancienne maquette — c'est un outil d'éditeur, pas du
// rendu d'écran).
export default function DesignPreview({ config, hoverTarget = null, designId = null }) {
  const [widthKey, setWidthKey] = useState('ipad');
  const [screen, setScreen] = useState('start');
  const viewportRef = useRef(null);
  const previewRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (hoverTarget?.screen) setScreen(hoverTarget.screen);
  }, [hoverTarget?.screen]);

  const target = WIDTHS.find((w) => w.key === widthKey) ?? WIDTHS[1];
  const vars = designToVars(config, screen);
  const pulseKey = hoverTarget?.screen === screen ? hoverTarget.key : null;

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

  const resolveAssetUrl = designId ? (filename) => api.designAssetUrl(designId, filename) : (f) => f;
  const demoEvent = { ...DEMO_EVENT, design: config };

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
          <div className="kapsule-guest design-preview" style={vars} ref={previewRef}>
            <Screen
              screen={screen}
              event={demoEvent}
              resolveAssetUrl={resolveAssetUrl}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Screen({ screen, event, resolveAssetUrl }) {
  if (screen === 'name') {
    return (
      <NameInput
        event={event}
        onSession={noop}
        onBack={noop}
        onClosed={noop}
        createSession={fakeCreateSession}
      />
    );
  }
  if (screen === 'recording') {
    return (
      <RecordingScreen
        question={DEMO_QUESTION}
        sessionId="preview"
        onNext={noop}
        onLockChange={noop}
        showcase
      />
    );
  }
  if (screen === 'thanks') {
    return (
      <ThankYouScreen
        onRestart={noop}
        thanksText={null}
        design={event.design}
        resolveAssetUrl={resolveAssetUrl}
      />
    );
  }
  return (
    <StartScreen
      event={event}
      onStart={noop}
      resolveAssetUrl={resolveAssetUrl}
    />
  );
}
