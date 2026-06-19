import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, clearToken } from '../../api/client.js';

const GB = 1024 ** 3;
const DISK_WARN_BYTES = 10 * GB;
const DISK_POLL_MS = 30_000;

function DiskIndicator({ freeBytes }) {
  if (freeBytes == null) return null;
  const gb = (freeBytes / GB).toFixed(1);
  const critical = freeBytes < DISK_WARN_BYTES;
  return (
    <span className={`disk-indicator${critical ? ' disk-indicator--critical' : ''}`}>
      💾 {gb} Go libres
    </span>
  );
}

// tabs : [{ id, label }] — définit les onglets affichés
// clearTokenFn : fonction de déconnexion (clearToken pour client, clearTechToken pour tech)
// role : 'client' | 'tech' — affiche le bandeau « espace technicien » si 'tech'
// isPreview : true → bandeau « BORNE D'ESSAI »
export default function AdminLayout({ activeTab, onTabChange, onLogout, children, tabs, clearTokenFn = clearToken, role = 'client', isPreview = false, eventName = null, currentUser = null }) {
  const [freeBytes, setFreeBytes] = useState(null);
  const intervalRef = useRef(null);

  const fetchDisk = useCallback(async () => {
    try {
      const data = await api.adminHealth();
      setFreeBytes(data?.disk?.free_bytes ?? null);
    } catch { /* non bloquant */ }
  }, []);

  useEffect(() => {
    fetchDisk();
    intervalRef.current = setInterval(fetchDisk, DISK_POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchDisk]);

  function handleLogout() {
    clearTokenFn();
    onLogout();
  }

  return (
    <div className={`admin-layout${role === 'tech' ? ' admin-layout--tech' : ''}`}>
      {isPreview && (
        <div className="admin-banner admin-banner--preview" role="status">
          BORNE D'ESSAI — données non envoyées
        </div>
      )}
      {role === 'tech' && (
        <div className="admin-banner admin-banner--tech" role="status">
          ⚙️ Espace technicien
        </div>
      )}
      <header className="admin-header">
        <span className="admin-header__title">Kapsule — Admin{eventName ? ` · ${eventName}` : ''}</span>
        <DiskIndicator freeBytes={freeBytes} />
        {currentUser && <span className="admin-header__user">{currentUser}</span>}
        <button className="btn btn--secondary btn--small" onClick={handleLogout}>
          Déconnexion
        </button>
      </header>

      <nav className="admin-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`admin-tab${activeTab === tab.id ? ' admin-tab--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="admin-main" role="tabpanel">
        {children}
      </main>
    </div>
  );
}
