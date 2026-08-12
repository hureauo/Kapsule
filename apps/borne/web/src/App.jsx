import React, { useEffect, useState } from 'react';
import GuestPage from './pages/GuestPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import BornePage from './pages/BornePage.jsx';

// Routing manuel : pas de react-router pour les deux zones admin (§6A.3)
// Navigation entre zones via window.location.href = '...' → rechargement complet.
// Phase B : /admin/tech devient /borne (console machine — identité, événements,
// disque/horloge/caméra, synchro), /admin ne porte plus que l'événement actif.
export default function App() {
  const [isPreview, setIsPreview] = useState(false);
  const [eventName, setEventName] = useState(null);

  useEffect(() => {
    fetch('/api/event')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.is_preview) setIsPreview(true);
        if (d?.name) setEventName(d.name);
      })
      .catch(() => {});
  }, []);

  const path = window.location.pathname;
  // Signet vers l'ancienne URL (avant Phase B) : redirige plutôt que de laisser
  // /admin/tech retomber silencieusement sur la console client (startsWith('/admin')).
  if (path.startsWith('/admin/tech')) {
    window.location.replace('/borne');
    return null;
  }
  if (path.startsWith('/borne')) return <BornePage isPreview={isPreview} eventName={eventName} />;
  if (path.startsWith('/admin')) return <AdminPage isPreview={isPreview} eventName={eventName} />;
  // .kapsule-guest scope le CSS partagé (@kapsule/guest-ui/guest.css) — l'admin
  // n'est jamais dans ce wrapper, aucun risque de collision avec ses .btn/.modal.
  return (
    <div className="kapsule-guest">
      <GuestPage isPreview={isPreview} />
    </div>
  );
}
