import React, { useEffect, useState } from 'react';
import GuestPage from './pages/GuestPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import BornePage from './pages/BornePage.jsx';
import OnboardingScreen, { useOnboardingGate } from './components/admin/OnboardingScreen.jsx';

// Routing manuel : pas de react-router pour les deux zones admin (§6A.3)
// Navigation entre zones via window.location.href = '...' → rechargement complet.
// Phase B : /admin/tech devient /borne (console machine — identité, événements,
// disque/horloge/caméra, synchro), /admin ne porte plus que l'événement actif.
export default function App() {
  const [isPreview, setIsPreview] = useState(false);
  const [eventName, setEventName] = useState(null);

  useEffect(() => {
    fetch('/api/event')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.is_preview) setIsPreview(true);
        if (d?.name) setEventName(d.name);
      })
      .catch(() => {});
  }, []);

  const path = window.location.pathname;
  const isGuestRoot = !path.startsWith('/borne') && !path.startsWith('/admin');

  // Tant que la borne n'est pas appairée, la racine montre directement le
  // MÊME écran que /borne (littéralement <OnboardingScreen/>, pas un résumé
  // maison) plutôt que le kiosque invité — c'est ce qu'un technicien voit en
  // premier en ouvrant l'IP de la borne, pas besoin de savoir qu'il faut
  // aller sur /borne. Le formulaire propose lui-même un champ URL du Hub
  // quand elle n'est pas préconfigurée — pas de cas particulier "mode
  // autonome" à gérer ici (§1 PROJET.md : capacité retirée du code, jamais
  // restaurée — aucune route ne crée plus d'événement local sans Hub).
  const { pairing, showOnboarding, confirmOnboarding } = useOnboardingGate(isGuestRoot);

  // Signet vers l'ancienne URL (avant Phase B) : redirige plutôt que de laisser
  // /admin/tech retomber silencieusement sur la console client (startsWith('/admin')).
  if (path.startsWith('/admin/tech')) {
    window.location.replace('/borne');
    return null;
  }
  if (path.startsWith('/borne')) return <BornePage isPreview={isPreview} eventName={eventName} />;
  if (path.startsWith('/admin')) return <AdminPage isPreview={isPreview} eventName={eventName} />;

  // OnboardingScreen est un composant admin/borne (classes CSS non préfixées,
  // cf. app.css) : rendu HORS du wrapper .kapsule-guest ci-dessous, sinon les
  // classes .kapsule-guest .screen/.text--muted (plus spécifiques, dupliquées
  // dans @kapsule/guest-ui pour le parcours invité) l'emporteraient sur les
  // siennes et casseraient sa mise en page.
  if (showOnboarding) {
    // Un pull réussi pendant l'appairage sauvegarde déjà une session
    // technicien (OnboardingScreen → saveTechToken) — inutile ici de la
    // relire comme le fait BornePage : la racine n'a pas de notion d'auth
    // (kiosque invité), elle tombe juste sur GuestPage ensuite. Le token
    // sauvegardé profite silencieusement d'une visite ultérieure sur /borne.
    return <OnboardingScreen status={pairing} onDone={confirmOnboarding} />;
  }

  // .kapsule-guest scope le CSS partagé (@kapsule/guest-ui/guest.css) — l'admin
  // n'est jamais dans ce wrapper, aucun risque de collision avec ses .btn/.modal.
  return (
    <div className="kapsule-guest">
      <GuestPage isPreview={isPreview} />
    </div>
  );
}
