import React, { useState } from 'react';
import { isAuthenticated } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import QuestionManager from '../components/admin/QuestionManager.jsx';
import VideoList from '../components/admin/VideoList.jsx';
import SyncPanel from '../components/admin/SyncPanel.jsx';

export default function AdminPage() {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [activeTab, setActiveTab] = useState('event');

  if (!authed) {
    return <AdminLogin onSuccess={() => setAuthed(true)} />;
  }

  function renderPanel() {
    switch (activeTab) {
      case 'event':     return <EventPanel />;
      case 'preflight': return <PreflightPanel />;
      case 'questions': return <QuestionManager />;
      case 'videos':    return <VideoList />;
      case 'sync':      return <SyncPanel />;
      default:          return null;
    }
  }

  return (
    <AdminLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={() => setAuthed(false)}
    >
      {renderPanel()}
    </AdminLayout>
  );
}
