import React, { useState } from 'react';
import { isTechAuthenticated, saveTechToken, clearTechToken, getCurrentTechEmail, hasTechRoleInToken, api } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import IdentityPanel from '../components/admin/IdentityPanel.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import SyncPanel from '../components/admin/SyncPanel.jsx';
import OnboardingScreen, { useOnboardingGate } from '../components/admin/OnboardingScreen.jsx';

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
  // useOnboardingGate (partagé avec App.jsx, racine) : reste sur l'onboarding
  // tant que la borne a été vue non-appairée PENDANT cette session et pas
  // encore confirmée (onDone) — pas juste dès que hasToken passe à true,
  // sinon l'écran disparaîtrait avant même d'avoir pu montrer le résultat du
  // pull (événement chargé ? aucun assigné ? Hub injoignable ?). Une borne
  // DÉJÀ appairée quand la page se charge (cas normal, quotidien) ne passe
  // jamais par cet état : va directement au login, comme avant.
  const { pairing, showOnboarding, confirmOnboarding } = useOnboardingGate(!authed);

  if (!authed) {
    if (!pairing) return null; // premier chargement du statut d'appairage — évite un flash du mauvais écran
    if (showOnboarding) {
      return (
        <OnboardingScreen
          status={pairing}
          onDone={() => {
            confirmOnboarding();
            // Un pull réussi pendant l'onboarding a déjà sauvegardé une session
            // technicien (OnboardingScreen → saveTechToken) : pas besoin de
            // repasser par AdminLogin dans ce cas, re-vérifier isTechAuthenticated()
            // suffit à sauter directement dans la console.
            setAuthed(isTechAuthenticated());
          }}
        />
      );
    }
    // Plus de TECH_PASSWORD (retiré, PROJET.md §11.30) : seul le PIN partagé
    // (tech_pin, pullé avec l'événement) ouvre la console désormais.
    return (
      <AdminLogin
        title="Console borne"
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
