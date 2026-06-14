import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';

function formatDuration(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// ── Modal lecture vidéo ───────────────────────────────────────────────────────

function VideoModal({ eventId, video, onClose }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-box modal-box--video">
        <div className="modal-header">
          <span className="modal-title">{video.guest_name} — {video.question_text}</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        {/* playsInline obligatoire iOS §11.5 */}
        <video
          className="gallery-modal-video"
          src={api.videoStreamUrl(eventId, video.id)}
          controls
          autoPlay
          playsInline
        />
        <div className="modal-footer">
          <a
            href={api.videoDownloadUrl(eventId, video.id)}
            className="btn btn--ghost btn--sm"
            download
          >
            Télécharger
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Composant principal ───────────────────────────────────────────────────────

export default function VideoGallery({ eventId, eventName }) {
  const navigate = useNavigate();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);         // vidéo sélectionnée pour la modal
  const [archivePending, setArchivePending] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // videoId en attente de confirmation
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purgeError, setPurgeError] = useState('');
  const [purging, setPurging] = useState(false);

  const loadVideos = useCallback(async () => {
    try {
      const data = await api.listVideos(eventId);
      setVideos(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  async function checkArchive() {
    try {
      const res = await api.getArchiveStatus(eventId);
      setArchivePending(res.status === 202);
    } catch {
      setArchivePending(true);
    }
  }

  useEffect(() => {
    loadVideos();
    checkArchive();
    // Polling sur l'état du ZIP, stoppé dès que l'archive est prête
    const tid = setInterval(async () => {
      if (!archivePending) { clearInterval(tid); return; }
      await checkArchive();
    }, 5000);
    return () => clearInterval(tid);
  }, [eventId, loadVideos]);

  async function handleDelete(videoId) {
    try {
      await api.deleteVideo(eventId, videoId);
      setDeleteConfirm(null);
      await loadVideos();
      setArchivePending(true); // invalidation — un nouveau job archive sera enfilé
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePurge() {
    if (purgeConfirm !== eventName) {
      setPurgeError(`Saisissez exactement : ${eventName}`);
      return;
    }
    setPurging(true);
    setPurgeError('');
    try {
      await api.deleteEvent(eventId, eventName);
      navigate('/events', { replace: true });
    } catch (err) {
      setPurgeError(err.message);
      setPurging(false);
    }
  }

  if (loading) return <p className="text--muted">Chargement de la galerie…</p>;
  if (error) return <p className="error-msg">{error}</p>;

  return (
    <div className="gallery">
      {/* Barre d'outils */}
      <div className="gallery-toolbar">
        <a href={api.csvExportUrl(eventId)} className="btn btn--ghost btn--sm" download>
          Exporter CSV
        </a>
        {archivePending ? (
          <button className="btn btn--ghost btn--sm" disabled title="Le ZIP est en cours de préparation">
            Tout télécharger (ZIP) — préparation…
          </button>
        ) : (
          <a href={api.archiveUrl(eventId)} className="btn btn--primary btn--sm" download>
            Tout télécharger (ZIP)
          </a>
        )}
      </div>

      {/* Grille de cartes */}
      {videos.length === 0 ? (
        <p className="text--muted">Aucune vidéo dans cet événement.</p>
      ) : (
        <div className="gallery-grid">
          {videos.map((v) => (
            <div key={v.id} className="gallery-card">
              {/* Miniature cliquable */}
              <button
                className="gallery-thumb-btn"
                onClick={() => setModal(v)}
                aria-label={`Lire la vidéo de ${v.guest_name}`}
              >
                {v.thumbnail ? (
                  <img
                    src={api.thumbnailUrl(eventId, v.id)}
                    alt={`Miniature ${v.guest_name}`}
                    className="gallery-thumb"
                  />
                ) : (
                  <div className="gallery-thumb gallery-thumb--placeholder">▶</div>
                )}
              </button>

              {/* Métadonnées */}
              <div className="gallery-card-body">
                <p className="gallery-card-name">{v.guest_name}</p>
                <p className="gallery-card-question text--muted">{v.question_text}</p>
                <p className="text--muted gallery-card-meta">
                  {formatDuration(v.duration_s)} · {formatSize(v.size)}
                </p>
              </div>

              {/* Actions */}
              <div className="gallery-card-actions">
                <button className="btn btn--ghost btn--sm" onClick={() => setModal(v)}>
                  Lire
                </button>
                <a
                  href={api.videoDownloadUrl(eventId, v.id)}
                  className="btn btn--ghost btn--sm"
                  download
                >
                  Télécharger
                </a>
                {deleteConfirm === v.id ? (
                  <>
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() => handleDelete(v.id)}
                    >
                      Confirmer la suppression
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => setDeleteConfirm(null)}
                    >
                      Annuler
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setDeleteConfirm(v.id)}
                  >
                    Supprimer
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Purge RGPD */}
      <section className="panel-section panel-section--danger">
        <h3 className="panel-section__title">Supprimer l'événement (RGPD)</h3>
        <p className="text--muted">
          Cette action supprime <strong>définitivement</strong> toutes les vidéos, sessions et données invités.
          Saisissez le nom de l'événement pour confirmer.
        </p>
        <div className="purge-form">
          <input
            type="text"
            className="hub-input"
            placeholder={eventName}
            value={purgeConfirm}
            onChange={(e) => setPurgeConfirm(e.target.value)}
          />
          <button
            className="btn btn--danger"
            onClick={handlePurge}
            disabled={purging}
          >
            {purging ? 'Suppression…' : "Supprimer l'événement"}
          </button>
        </div>
        {purgeError && <p className="error-msg">{purgeError}</p>}
      </section>

      {/* Modal vidéo */}
      {modal && (
        <VideoModal
          eventId={eventId}
          video={modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
