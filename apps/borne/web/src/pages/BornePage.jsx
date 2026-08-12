import React, { useState } from 'react';
import { isTechAuthenticated, saveTechToken, clearTechToken, getCurrentTechEmail, hasTechRoleInToken, api } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import IdentityPanel from '../components/admin/IdentityPanel.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import SyncPanel from '../components/admin/SyncPanel.jsx';
import OnboardingScreen, { usePairingStatus } from '../components/admin/OnboardingScreen.jsx';

// Console machine de la borne (Phase B, ex /admin/tech) — gestion de la
// borne elle-même (identité, événements assignés, machine, synchro),
// distincte de /admin qui ne porte que le contenu de l'événement ACTIF
// (questions, vidéos, design). Même garde qu'avant (tech_borne, §11.19).
const BORNE_TABS = [
  { id: 'identity',  label: 'Identité'   },
  { id: 'events',    label: 'Événements' },
  { id: 'machine',   label: 'Machine'    },
  { id: 'sync',      label: 'Synchro'    },
];

export default function BornePage({ isPreview = false, eventName = null }) {
  const [authed, setAuthed] = useState(isTechAuthenticated());
  const [activeTab, setActiveTab] = useState('events');
  // Permet de quitter l'onboarding sans attendre hasToken=true (mode 100%
  // autonome, sans Hub prévu — cf. OnboardingScreen).
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  // Interrogé tant que non authentifié : détermine si on montre l'onboarding
  // (aucun token — pas de mot de passe requis, §Phase C) ou le login normal.
  const pairing = usePairingStatus(!authed);

  if (!authed) {
    if (!pairing) return null; // premier chargement du statut d'appairage — évite un flash du mauvais écran
    if (!pairing.hasToken && !skipOnboarding) {
      return <OnboardingScreen status={pairing} onSkip={() => setSkipOnboarding(true)} />;
    }
    // Token configuré mais pas encore d'événement actif (juste après appairage,
    // avant le premier pull) : pas de tech_pin disponible tant qu'aucun
    // événement n'a été pullé — secours par TECH_PASSWORD.
    return (
      <AdminLogin
        title="Console borne"
        mode={pairing.hasActiveEvent ? 'pin' : 'password'}
        onSuccess={(token) => {
          if (!hasTechRoleInToken(token)) return false;
          saveTechToken(token);
          setAuthed(true);
        }}
      />
    );
  }

  function renderPanel() {
    switch (activeTab) {
      case 'identity': return <IdentityPanel />;
      case 'events':   return <EventPanel />;
      case 'machine':  return <PreflightPanel />;
      case 'sync':     return <SyncPanel />;
      default:         return null;
    }
  }

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={() => setAuthed(false)}
      tabs={BORNE_TABS}
      clearTokenFn={clearTechToken}
      fetchHealthFn={api.techAdminHealth}
      role="tech"
      isPreview={isPreview}
      eventName={eventName}
      currentUser={getCurrentTechEmail()}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
