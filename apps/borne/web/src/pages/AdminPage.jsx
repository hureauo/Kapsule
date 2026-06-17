import React, { useState } from 'react';
import { isAuthenticated, saveToken, clearToken } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import QuestionManager from '../components/admin/QuestionManager.jsx';
import VideoList from '../components/admin/VideoList.jsx';
import DesignPanel from '../components/admin/DesignPanel.jsx';

const CLIENT_TABS = [
  { id: 'event',     label: 'Événement' },
  { id: 'questions', label: 'Questions' },
  { id: 'videos',    label: 'Vidéos'   },
  { id: 'design',    label: 'Design'   },
];

export default function AdminPage({ isPreview = false }) {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [activeTab, setActiveTab] = useState('event');

  if (!authed) {
    return (
      <AdminLogin
        title="Administration"
        onSuccess={(token) => { saveToken(token); setAuthed(true); }}
      />
    );
  }

  function renderPanel() {
    switch (activeTab) {
      case 'event':     return <EventPanel />;
      case 'questions': return <QuestionManager />;
      case 'videos':    return <VideoList />;
      case 'design':    return <DesignPanel />;
      default:          return null;
    }
  }

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={() => setAuthed(false)}
      tabs={CLIENT_TABS}
      clearTokenFn={clearToken}
      isPreview={isPreview}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
