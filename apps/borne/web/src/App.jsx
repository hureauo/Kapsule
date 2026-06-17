import React from 'react';
import GuestPage from './pages/GuestPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import TechPage from './pages/TechPage.jsx';

// Routing manuel : pas de react-router pour les deux zones admin (§6A.3)
// Navigation entre zones via window.location.href = '...' → rechargement complet.
export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/admin/tech')) return <TechPage />;
  if (path.startsWith('/admin')) return <AdminPage />;
  return <GuestPage />;
}
