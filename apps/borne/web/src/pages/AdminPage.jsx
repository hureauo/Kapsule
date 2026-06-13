import React, { useState } from 'react';
import { isAuthenticated } from '../api/client.js';
import AdminLogin from '../components/admin/AdminLogin.jsx';
import AdminLayout from '../components/admin/AdminLayout.jsx';
import EventPanel from '../components/admin/EventPanel.jsx';
import PreflightPanel from '../components/admin/PreflightPanel.jsx';
import QuestionManager from '../components/admin/QuestionManager.jsx';

function PanelPlaceholder({ name }) {
  return (
    <div className="panel-placeholder">
      <p className="text--muted">Panneau « {name} » — implémenté en phase 1d</p>
    </div>
  );
}

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
      case 'videos':    return <PanelPlaceholder name="Vidéos" />;
      case 'sync':      return <PanelPlaceholder name="Synchro" />;
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
