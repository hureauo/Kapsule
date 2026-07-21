// Barrel @kapsule/guest-ui (designUI). Écrans du parcours invité partagés
// entre le runtime borne (kiosque réel) et l'aperçu live de l'éditeur Hub —
// un seul rendu, jamais deux versions à synchroniser à la main.
//
// Composants React purs vis-à-vis du réseau/matériel : les dépendances
// externes (résolution d'URL d'image, création de session, upload vidéo,
// caméra) sont injectées par props, jamais importées en dur ici — c'est ce
// qui permet au même composant de tourner en prod (borne) et en vitrine
// (aperçu Hub, sans backend ni caméra).
//
// designUI.A a validé que le JSX de ce package (workspace symlinké, pas de
// build séparé — même pattern que @kapsule/core) est bien transpilé par vite
// dans les deux apps consommatrices, sans configuration supplémentaire.

export { designToVars, MANAGED_DESIGN_VARS, imageWidthStyle } from './design.js';

export { default as StartScreen } from './screens/StartScreen.jsx';
export { default as ThankYouScreen } from './screens/ThankYouScreen.jsx';
export { default as QuestionNav } from './screens/QuestionNav.jsx';
export { default as QuestionSheet } from './screens/QuestionSheet.jsx';
export { default as NameInput } from './screens/NameInput.jsx';
export { default as RecapScreen } from './screens/RecapScreen.jsx';
export { default as RecordingScreen } from './screens/RecordingScreen.jsx';
export { default as useMediaRecorder, REC_STATUS } from './useMediaRecorder.js';
