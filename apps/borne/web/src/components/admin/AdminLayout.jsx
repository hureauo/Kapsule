import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, clearToken } from '../../api/client.js';

const TABS = [
  { id: 'event',     label: 'Événement' },
  { id: 'preflight', label: 'Préflight'  },
  { id: 'questions', label: 'Questions'  },
  { id: 'videos',    label: 'Vidéos'    },
  { id: 'sync',      label: 'Synchro'   },
];

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

export default function AdminLayout({ activeTab, onTabChange, onLogout, children }) {
  const [freeBytes, setFreeBytes] = useState(null);
  const intervalRef = useRef(null);

  const fetchDisk = useCallback(async () => {
    try {
      const data = await api.health();
      setFreeBytes(data?.disk?.free_bytes ?? null);
    } catch { /* non bloquant */ }
  }, []);

  useEffect(() => {
    fetchDisk();
    intervalRef.current = setInterval(fetchDisk, DISK_POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchDisk]);

  function handleLogout() {
    clearToken();
    onLogout();
  }

  return (
    <div className="admin-layout">
      <header className="admin-header">
        <span className="admin-header__title">Kapsule — Admin</span>
        <DiskIndicator freeBytes={freeBytes} />
        <button className="btn btn--secondary btn--small" onClick={handleLogout}>
          Déconnexion
        </button>
      </header>

      <nav className="admin-tabs" role="tablist">
        {TABS.map((tab) => (
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
