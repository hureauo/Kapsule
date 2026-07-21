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
// Contenu réel ajouté à partir de designUI.C.

export {};
