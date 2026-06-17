import React, { useState } from 'react';
import { isTechAuthenticated, saveTechToken, clearTechToken } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import SyncPanel from '../components/admin/SyncPanel.jsx';

const TECH_TABS = [
  { id: 'preflight', label: 'Préflight' },
  { id: 'sync',      label: 'Synchro'  },
];

export default function TechPage({ isPreview = false }) {
  const [authed, setAuthed] = useState(isTechAuthenticated());
  const [activeTab, setActiveTab] = useState('preflight');

  if (!authed) {
    return (
      <AdminLogin
        title="Espace technicien"
        onSuccess={(token) => { saveTechToken(token); setAuthed(true); }}
      />
    );
  }

  function renderPanel() {
    switch (activeTab) {
      case 'preflight': return <PreflightPanel />;
      case 'sync':      return <SyncPanel />;
      default:          return null;
    }
  }

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={() => setAuthed(false)}
      tabs={TECH_TABS}
      clearTokenFn={clearTechToken}
      role="tech"
      isPreview={isPreview}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
