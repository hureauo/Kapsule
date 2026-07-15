import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import { formatSqlDate } from '../../utils/format.js';

// Historique d'un design (§9bis) : liste des versions + restauration.
// L'API est append-only — restaurer re-versionne l'état courant avant de le
// remplacer, donc une restauration ne fait jamais perdre la config écrasée.

export default function VersionHistory({ design, readOnly, onRestored, onError }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await api.listDesignVersions(design.id));
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
    // Dépendre de l'OBJET design (recréé à chaque rechargement de la liste par
    // la page), pas seulement de design.id : chaque enregistrement crée une
    // version, l'historique doit la voir sans changer de design sélectionné.
  }, [design, onError]);

  useEffect(() => { load(); }, [load]);

  async function handleRestore(version) {
    if (!window.confirm(
      `Restaurer la version du ${formatSqlDate(version.created_at)} ?\n\n`
      + 'La configuration actuelle est conservée dans l\'historique.',
    )) return;

    setRestoring(version.id);
    try {
      await api.restoreDesignVersion(design.id, version.id);
      await load();
      await onRestored?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setRestoring(null);
    }
  }

  // « Chargement… » seulement au premier affichage : lors d'un rafraîchissement
  // (après un enregistrement), on garde la liste visible plutôt que de clignoter.
  if (loading && versions.length === 0) return <p className="text--muted">Chargement…</p>;
  if (!loading && versions.length === 0) return <p className="text--muted">Aucune version.</p>;

  return (
    <ul className="designs-versions">
      {versions.map((v, i) => (
        <li key={v.id} className="designs-version">
          <div className="designs-version__info">
            <span className="designs-version__date">{formatSqlDate(v.created_at)}</span>
            <span className="designs-version__author">{v.author ?? 'inconnu'}</span>
          </div>
          {i === 0 ? (
            <span className="designs-badge">Actuelle</span>
          ) : !readOnly && (
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => handleRestore(v)}
              disabled={restoring !== null}
            >
              {restoring === v.id ? 'Restauration…' : 'Restaurer'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
