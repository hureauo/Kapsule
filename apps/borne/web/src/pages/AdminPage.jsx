import React, { useState } from 'react';
import { isAuthenticated, saveToken, clearToken, getCurrentUserEmail, hasAdminRoleInToken } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import QuestionManager from '../components/admin/QuestionManager.jsx';
import VideoList from '../components/admin/VideoList.jsx';
import DesignPanel from '../components/admin/DesignPanel.jsx';

const ALL_TABS = [
  { id: 'event',     label: 'Événement', hideInPreview: true },
  { id: 'questions', label: 'Questions' },
  { id: 'videos',    label: 'Vidéos'   },
  { id: 'design',    label: 'Design'   },
];

export default function AdminPage({ isPreview = false, eventName = null }) {
  const tabs = ALL_TABS.filter(t => !isPreview || !t.hideInPreview);
  const [authed, setAuthed] = useState(isAuthenticated());
  const [activeTab, setActiveTab] = useState(isPreview ? 'questions' : 'event');

  if (!authed) {
    return (
      <AdminLogin
        title="Administration"
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
      case 'event':     return <EventPanel />;
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
      tabs={tabs}
      clearTokenFn={clearToken}
      isPreview={isPreview}
      eventName={eventName}
      currentUser={getCurrentUserEmail()}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
