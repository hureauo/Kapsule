import React, { useState } from 'react';
import { isAuthenticated, saveToken, clearToken, getCurrentUserEmail, hasAdminRoleInToken } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import QuestionManager from '../components/admin/QuestionManager.jsx';
import VideoList from '../components/admin/VideoList.jsx';
import DesignPanel from '../components/admin/DesignPanel.jsx';

// Phase B : ne porte plus que le contenu de l'événement ACTIF (questions,
// vidéos, design) — la gestion de l'événement lui-même (activer, clôturer,
// purger) a déménagé dans la console machine /borne (onglet Événements).
const TABS = [
  { id: 'questions', label: 'Questions' },
  { id: 'videos',    label: 'Vidéos'   },
  { id: 'design',    label: 'Design'   },
];

export default function AdminPage({ isPreview = false, eventName = null }) {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [activeTab, setActiveTab] = useState('questions');

  if (!authed) {
    return (
      <AdminLogin
        title="Administration"
        mode="pin"
        onSuccess={(token) => {
          if (!hasAdminRoleInToken(token)) return false;
          saveToken(token);
          setAuthed(true);
        }}
      />
    );
  }

  function renderPanel() {
    switch (activeTab) {
      case 'questions': return <QuestionManager />;
      case 'videos':    return <VideoList isPreview={isPreview} />;
      case 'design':    return <DesignPanel />;
      default:          return null;
    }
  }

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={() => setAuthed(false)}
      tabs={TABS}
      clearTokenFn={clearToken}
      isPreview={isPreview}
      eventName={eventName}
      currentUser={getCurrentUserEmail()}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
