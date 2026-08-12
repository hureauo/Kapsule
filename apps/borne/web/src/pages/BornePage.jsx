import React, { useState } from 'react';
import { isTechAuthenticated, saveTechToken, clearTechToken, getCurrentTechEmail, hasTechRoleInToken, api } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import IdentityPanel from '../components/admin/IdentityPanel.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import SyncPanel from '../components/admin/SyncPanel.jsx';

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

  if (!authed) {
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
