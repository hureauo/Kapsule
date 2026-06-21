/**
 * PreviewGallery — Galerie des vidéos enregistrées sur la borne d'essai.
 *
 * Les vidéos vivent dans le container preview (DATA_DIR isolé, pas de push Hub).
 * Ce composant les affiche via le proxy Hub → borne (/preview-videos/*).
 *
 * Deux modes sélectionnables par l'admin :
 *   - "liste"  (défaut) : grille de cartes avec poster <video preload=metadata>
 *                         Le navigateur charge la 1re frame comme aperçu visuel.
 *   - "lecture"         : ouverture d'une modal de lecture complète.
 *
 * Pas de CSV / ZIP / delete / purge RGPD : réservés au post-push, bloqués côté
 * borne en PREVIEW_MODE de toute façon.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client.js';
import { formatDuration, formatSize } from '../utils/format.js';

// ── Modal lecture vidéo (calquée sur VideoGallery) ───────────────────────────

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
          <span className="modal-title">
            {video.guest_name} — {video.question_text}
          </span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        {/* playsInline obligatoire iOS §11.5 */}
        <video
          className="gallery-modal-video"
          src={api.previewVideoStreamUrl(eventId, video.id)}
          controls
          autoPlay
          playsInline
        />
      </div>
    </div>
  );
}

// ── Composant principal ───────────────────────────────────────────────────────

export default function PreviewGallery({ eventId }) {
  const [videos, setVideos]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');      // '' | 'offline' | message
  const [modal, setModal]       = useState(null);    // vidéo sélectionnée
  const [mode, setMode]         = useState('liste'); // 'liste' | 'lecture'
  const [storage, setStorage]   = useState(null);    // { used_bytes, quota_bytes }

  const loadVideos = useCallback(async () => {
    setError('');
    try {
      const [data, stor] = await Promise.all([
        api.listPreviewVideos(eventId),
        api.getPreviewStorage(eventId).catch(() => null),
      ]);
      setVideos(data);
      setStorage(stor);
    } catch (err) {
      if (err.status === 503) {
        setError('offline');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { loadVideos(); }, [loadVideos]);

  if (loading) return <p className="text--muted">Chargement de la galerie d'essai…</p>;

  if (error === 'offline') {
    return (
      <div>
        <p className="text--muted">
          La borne d'essai est hors ligne — démarrez-la depuis le panneau d'administration.
        </p>
        <button className="btn btn--ghost btn--sm" onClick={() => { setLoading(true); loadVideos(); }}>
          Réessayer
        </button>
      </div>
    );
  }

  if (error) return <p className="error-msg">{error}</p>;

  return (
    <div className="gallery">
      {/* En-tête avec toggle de mode et bouton rafraîchir */}
      <div className="gallery-toolbar">
        <span className="text--muted" style={{ fontSize: '13px' }}>
          Vidéos de la borne d'essai ({videos.length})
        </span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            className={`btn btn--sm ${mode === 'liste' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setMode('liste')}
          >
            Liste
          </button>
          <button
            className={`btn btn--sm ${mode === 'lecture' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setMode('lecture')}
          >
            Lecture
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => { setLoading(true); loadVideos(); }}>
            ↺ Rafraîchir
          </button>
        </div>
      </div>

      {/* Barre de stockage */}
      {storage && storage.quota_bytes > 0 && (
        <div style={{ margin: '8px 0 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            <span>Stockage borne d'essai</span>
            <span>{formatSize(storage.used_bytes)} / {formatSize(storage.quota_bytes)}</span>
          </div>
          <div style={{ height: '6px', borderRadius: '3px', background: 'var(--color-border)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              borderRadius: '3px',
              width: `${Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100).toFixed(1)}%`,
              background: storage.used_bytes / storage.quota_bytes > 0.9 ? '#dc2626' : 'var(--color-primary)',
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Grille de cartes */}
      {videos.length === 0 ? (
        <p className="text--muted">Aucune vidéo enregistrée sur la borne d'essai.</p>
      ) : (
        <div className="gallery-grid">
          {videos.map((v) => (
            <div key={v.id} className="gallery-card">
              {/* Aperçu vidéo — la 1re frame fait office de poster.
                  preload=metadata charge juste les métadonnées + quelques frames
                  (suffisant pour l'aperçu visuel, sans télécharger tout le fichier).
                  playsInline obligatoire iOS §11.5. */}
              <button
                className="gallery-thumb-btn"
                onClick={() => { setModal(v); setMode('lecture'); }}
                aria-label={`Lire la vidéo de ${v.guest_name}`}
              >
                <video
                  className="gallery-thumb"
                  src={api.previewVideoStreamUrl(eventId, v.id)}
                  preload="metadata"
                  muted
                  playsInline
                />
              </button>

              {/* Métadonnées */}
              <div className="gallery-card-body">
                <p className="gallery-card-name">{v.guest_name}</p>
                <p className="gallery-card-question text--muted">{v.question_text}</p>
                <p className="text--muted gallery-card-meta">
                  {v.duration_s != null ? formatDuration(v.duration_s) : '—'}
                  {' · '}
                  {formatSize(v.size)}
                </p>
              </div>

              {/* Action */}
              <div className="gallery-card-actions">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => { setModal(v); setMode('lecture'); }}
                >
                  Lire
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal lecture (ouverte en mode "lecture") */}
      {modal && mode === 'lecture' && (
        <VideoModal
          eventId={eventId}
          video={modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
