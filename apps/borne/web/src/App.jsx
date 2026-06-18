import React, { useEffect, useState } from 'react';
import GuestPage from './pages/GuestPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import TechPage from './pages/TechPage.jsx';

// Routing manuel : pas de react-router pour les deux zones admin (§6A.3)
// Navigation entre zones via window.location.href = '...' → rechargement complet.
export default function App() {
  const [isPreview, setIsPreview] = useState(false);
  const [eventName, setEventName] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => {
        if (d.isPreview) setIsPreview(true);
        if (d.eventName) setEventName(d.eventName);
      })
      .catch(() => {});
  }, []);

  const path = window.location.pathname;
  if (path.startsWith('/admin/tech')) return <TechPage isPreview={isPreview} eventName={eventName} />;
  if (path.startsWith('/admin')) return <AdminPage isPreview={isPreview} eventName={eventName} />;
  return <GuestPage isPreview={isPreview} />;
}
