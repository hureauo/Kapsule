import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken, getRole } from '../api/client.js';
import { formatSqlDate } from '../utils/format.js';
import DesignEditor from '../components/designs/DesignEditor.jsx';
import VersionHistory from '../components/designs/VersionHistory.jsx';

// Bibliothèque de designs (PROJET.md §9bis).
// Pas de router imbriqué : un state `selectedId` bascule liste ↔ détail.

export default function DesignsPage() {
  const [designs, setDesigns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const isSuperuser = getRole() === 'superuser';

  const load = useCallback(async () => {
    try {
      setDesigns(await api.listDesigns());
      setError('');
    } catch (err) {
      if (err.status === 401) { clearToken(); navigate('/login', { replace: true }); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => { load(); }, [load]);

  const selected = designs.find((d) => d.id === selectedId) ?? null;

  // Un client ne peut pas modifier un template : la vue détail passe en lecture
  // seule (même règle que la garde canWrite du backend).
  const canEdit = (d) => isSuperuser || (!d.is_template && d.owner_id !== null);

  async function run(fn) {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCreate() {
    const name = window.prompt('Nom du nouveau design ?');
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const design = await api.createDesign(name.trim());
      await load();
      setSelectedId(design.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(design) {
    const name = window.prompt('Nouveau nom ?', design.name);
    if (!name?.trim() || name === design.name) return;
    await run(() => api.updateDesign(design.id, { name: name.trim() }));
  }

  async function handleDuplicate(design) {
    await run(async () => {
      const copy = await api.duplicateDesign(design.id);
      setSelectedId(copy.id);
    });
  }

  async function handleDelete(design) {
    if (!window.confirm(`Supprimer le design « ${design.name} » ? Cette action est définitive.`)) return;
    await run(async () => {
      await api.deleteDesign(design.id);
      if (selectedId === design.id) setSelectedId(null);
    });
  }

  async function handlePromote(design) {
    if (!window.confirm(`Promouvoir « ${design.name} » en template ? Il deviendra visible par tous les clients.`)) return;
    await run(() => api.promoteDesign(design.id));
  }

  async function handleDemote(design) {
    if (!window.confirm(`Retirer « ${design.name} » des templates ? Il redeviendra privé.`)) return;
    await run(() => api.demoteDesign(design.id));
  }

  function handleLogout() {
    clearToken();
    navigate('/login', { replace: true });
  }

  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="hub-logo">Kapsule Hub</span>
        <div className="hub-header__actions">
          <button className="btn btn--ghost" onClick={() => navigate('/events')}>Événements</button>
          {isSuperuser && (
            <button className="btn btn--ghost" onClick={() => navigate('/admin')}>Administration</button>
          )}
          <button className="btn btn--ghost" onClick={handleLogout}>Déconnexion</button>
        </div>
      </header>

      <main className="hub-main">
        {error && <p className="error-msg">{error}</p>}

        {selected ? (
          <DesignDetail
            design={selected}
            readOnly={!canEdit(selected)}
            onBack={() => setSelectedId(null)}
            onChanged={load}
            onError={setError}
          />
        ) : (
          <DesignList
            designs={designs}
            loading={loading}
            creating={creating}
            isSuperuser={isSuperuser}
            onSelect={setSelectedId}
            onCreate={handleCreate}
            onRename={handleRename}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onPromote={handlePromote}
            onDemote={handleDemote}
          />
        )}
      </main>
    </div>
  );
}

// ── Vue liste ────────────────────────────────────────────────────────────────

function DesignList({
  designs, loading, creating, isSuperuser,
  onSelect, onCreate, onRename, onDuplicate, onDelete, onPromote, onDemote,
}) {
  if (loading) return <p className="text--muted">Chargement…</p>;

  const templates = designs.filter((d) => d.is_template);
  const mine = designs.filter((d) => !d.is_template && !isSuperuser);

  // Vue superuser : tous les designs clients, groupés par propriétaire.
  const byOwner = new Map();
  if (isSuperuser) {
    for (const d of designs) {
      if (d.is_template) continue;
      const key = d.owner_email ?? 'Sans propriétaire';
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(d);
    }
  }

  return (
    <>
      <div className="section-header">
        <h2 className="section-title">Designs</h2>
        <button className="btn btn--primary" onClick={onCreate} disabled={creating}>
          {creating ? 'Création…' : '+ Nouveau design'}
        </button>
      </div>

      {!isSuperuser && (
        <section className="panel-section">
          <h3 className="panel-section__title">Mes designs</h3>
          {mine.length === 0 ? (
            <p className="text--muted">Aucun design pour l'instant. Dupliquez un template pour démarrer.</p>
          ) : (
            <div className="designs-grid">
              {mine.map((d) => (
                <DesignCard
                  key={d.id} design={d} isSuperuser={isSuperuser}
                  onSelect={onSelect} onRename={onRename} onDuplicate={onDuplicate}
                  onDelete={onDelete} onPromote={onPromote} onDemote={onDemote}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="panel-section">
        <h3 className="panel-section__title">Templates</h3>
        {templates.length === 0 ? (
          <p className="text--muted">Aucun template.</p>
        ) : (
          <div className="designs-grid">
            {templates.map((d) => (
              <DesignCard
                key={d.id} design={d} isSuperuser={isSuperuser}
                onSelect={onSelect} onRename={onRename} onDuplicate={onDuplicate}
                onDelete={onDelete} onPromote={onPromote} onDemote={onDemote}
              />
            ))}
          </div>
        )}
      </section>

      {isSuperuser && (
        <section className="panel-section">
          <h3 className="panel-section__title">Tous les designs</h3>
          {byOwner.size === 0 ? (
            <p className="text--muted">Aucun design client.</p>
          ) : (
            [...byOwner.entries()].map(([owner, list]) => (
              <div key={owner} className="designs-owner-group">
                <h4 className="designs-owner-group__title">{owner}</h4>
                <div className="designs-grid">
                  {list.map((d) => (
                    <DesignCard
                      key={d.id} design={d} isSuperuser={isSuperuser}
                      onSelect={onSelect} onRename={onRename} onDuplicate={onDuplicate}
                      onDelete={onDelete} onPromote={onPromote} onDemote={onDemote}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </>
  );
}

function DesignCard({ design, isSuperuser, onSelect, onRename, onDuplicate, onDelete, onPromote, onDemote }) {
  const isSeed = design.is_template && design.owner_id === null;
  // Un client ne peut ni renommer ni supprimer un template ; le superuser, si.
  const editable = isSuperuser || !design.is_template;

  return (
    <article className="designs-card">
      <button className="designs-card__main" onClick={() => onSelect(design.id)}>
        <DesignSwatches config={design.config} />
        <span className="designs-card__name">{design.name}</span>
        <span className="designs-card__meta">
          {design.is_template && <span className="designs-badge">Template</span>}
          {formatSqlDate(design.updated_at)}
        </span>
      </button>

      <div className="designs-card__actions">
        <button className="btn btn--sm btn--ghost" onClick={() => onDuplicate(design)}>Dupliquer</button>
        {editable && (
          <button className="btn btn--sm btn--ghost" onClick={() => onRename(design)}>Renommer</button>
        )}
        {isSuperuser && !design.is_template && (
          <button className="btn btn--sm btn--ghost" onClick={() => onPromote(design)}>Promouvoir</button>
        )}
        {isSuperuser && design.is_template && !isSeed && (
          <button className="btn btn--sm btn--ghost" onClick={() => onDemote(design)}>Rétrograder</button>
        )}
        {editable && !isSeed && (
          <button className="btn btn--sm btn--danger" onClick={() => onDelete(design)}>Supprimer</button>
        )}
      </div>
    </article>
  );
}

// Aperçu compact : les couleurs structurantes du design.
function DesignSwatches({ config }) {
  const keys = ['bg', 'surface', 'text', 'primary', 'accent'];
  return (
    <span className="designs-swatches">
      {keys.map((k) => (
        <span
          key={k}
          className="designs-swatch"
          style={{ background: config?.colors?.[k] ?? 'transparent' }}
          title={k}
        />
      ))}
    </span>
  );
}

// ── Vue détail ───────────────────────────────────────────────────────────────

function DesignDetail({ design, readOnly, onBack, onChanged, onError }) {
  return (
    <>
      <div className="section-header">
        <div className="designs-detail__title">
          <button className="btn btn--ghost btn--sm" onClick={onBack}>← Designs</button>
          <h2 className="section-title">{design.name}</h2>
          {design.is_template && <span className="designs-badge">Template</span>}
        </div>
      </div>

      {readOnly && (
        <p className="text--muted designs-readonly">
          Ce template est en lecture seule. Dupliquez-le pour l'éditer.
        </p>
      )}

      <div className="designs-detail">
        <section className="panel-section designs-detail__editor">
          <DesignEditor design={design} readOnly={readOnly} onSaved={onChanged} onError={onError} />
        </section>

        <section className="panel-section designs-detail__side">
          <h3 className="panel-section__title">Historique</h3>
          <VersionHistory design={design} readOnly={readOnly} onRestored={onChanged} onError={onError} />
        </section>
      </div>
    </>
  );
}
