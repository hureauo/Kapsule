import React, { useCallback, useEffect, useState } from 'react';
import { api, videoStreamUrl, videoDownloadUrl, csvExportUrl } from '../../api/client.js';

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function VideoList({ isPreview = false }) {
  const [sessions, setSessions]     = useState([]);
  const [videos, setVideos]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [filterSession, setFilterSession] = useState('');

  // Modal de lecture
  const [playingUrl, setPlayingUrl] = useState(null);

  // Suppression
  const [deletingId, setDeletingId] = useState(null);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch { /* non bloquant */ }
  }, []);

  const loadVideos = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setVideos(await api.listVideos(filterSession || null));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filterSession]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { loadVideos(); }, [loadVideos]);

  async function handleDelete(id) {
    try {
      await api.deleteVideo(id);
      setDeletingId(null);
      await loadVideos();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="video-list">
      {/* Barre d'outils */}
      <div className="video-toolbar">
        <select
          className="admin-input video-toolbar__select"
          value={filterSession}
          onChange={(e) => setFilterSession(e.target.value)}
        >
          <option value="">Toutes les sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.guest_name} — {formatDate(s.started_at)}
            </option>
          ))}
        </select>

        {!isPreview && (
          <a
            className="btn btn--small btn--secondary"
            href={csvExportUrl()}
            download="export.csv"
          >
            ↓ Export CSV
          </a>
        )}

        <button className="btn btn--small btn--secondary" onClick={loadVideos}>
          ↺ Rafraîchir
        </button>
      </div>

      {error && <p className="text--error">{error}</p>}

      {loading ? (
        <p className="text--muted">Chargement…</p>
      ) : videos.length === 0 ? (
        <p className="text--muted">Aucune vidéo{filterSession ? ' pour cette session' : ''}.</p>
      ) : (
        <div className="video-grid">
          {videos.map((v) => (
            <div key={v.id} className="video-card">
              <div className="video-card__header">
                <span className="video-card__guest">{v.guest_name ?? '—'}</span>
                <span className="video-card__size">{formatSize(v.size)}</span>
              </div>
              <p className="video-card__question">{v.question_text}</p>
              <p className="video-card__date">{formatDate(v.recorded_at)}</p>
              <div className="video-card__actions">
                <button
                  className="btn btn--small btn--primary"
                  onClick={() => setPlayingUrl(videoStreamUrl(v.id))}
                >
                  ▶ Lire
                </button>
                {!isPreview && (
                  <a
                    className="btn btn--small btn--secondary"
                    href={videoDownloadUrl(v.id)}
                    download
                  >
                    ↓ Télécharger
                  </a>
                )}
                <button
                  className="btn btn--small btn--danger"
                  onClick={() => setDeletingId(v.id)}
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal de lecture — route /file Range-aware (scrubbing) */}
      {playingUrl && (
        <div className="modal-overlay" onClick={() => setPlayingUrl(null)}>
          <div className="modal modal--video" onClick={(e) => e.stopPropagation()}>
            <video
              className="video-modal__player"
              src={playingUrl}
              controls
              autoPlay
              playsInline
            />
            <button className="btn btn--small btn--secondary" onClick={() => setPlayingUrl(null)}>
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Confirmation de suppression */}
      {deletingId && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 className="modal__title">Supprimer la vidéo ?</h3>
            <p className="text--muted">Cette action est irréversible.</p>
            <div className="modal__actions">
              <button className="btn btn--small btn--secondary" onClick={() => setDeletingId(null)}>
                Annuler
              </button>
              <button className="btn btn--small btn--danger" onClick={() => handleDelete(deletingId)}>
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
