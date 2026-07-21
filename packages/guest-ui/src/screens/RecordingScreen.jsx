import React, { useEffect, useRef, useState } from 'react';
import useMediaRecorder, { REC_STATUS } from '../useMediaRecorder.js';

// Sous-états internes de l'écran d'enregistrement
const S = {
  INTRO: 'intro',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PREVIEW: 'preview',
  UPLOADING: 'uploading',
  ANSWERED: 'answered', // question déjà répondue (remontée depuis le parent)
};

function pad2(n) { return String(n).padStart(2, '0'); }
function formatDuration(s) { return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }

// Backoff exponentiel : min(2000·2^(n-1), 30000) ms (n commence à 1)
function retryDelay(attempt) { return Math.min(2000 * Math.pow(2, attempt - 1), 30000); }

// ── Composant principal ───────────────────────────────────────────────────────
// Keyé par questionIndex dans le parent → remount forcé à chaque question.
// V2 : plus de prop onBack (bouton « ← Retour » retiré — design/parcours-invite.md §12).
// Navigation en arrière possible uniquement depuis le récap (RecapScreen.onGo).
//
// showcase (designUI) : mode vitrine pour l'aperçu Hub — AUCUN accès caméra
// (requestPermission jamais appelé), rend un cadre caméra factice dans l'état
// INTRO, bouton « Commencer » inerte. Toutes les autres branches (countdown,
// recording, upload…) restent du code mort en mode showcase : l'utilisateur ne
// peut jamais les atteindre puisque le bouton qui déclenche la transition est
// désactivé. Comportement réel (showcase=false, défaut) strictement inchangé.
//
// uploadVideo/guestVideoUrl : injectés (borne : apps/borne/web/src/api/client.js
// réel ; aperçu Hub : jamais appelés en mode showcase, stubs acceptés).
export default function RecordingScreen({
  question,
  sessionId,
  existingVideoId,   // id si déjà répondue → sous-état ANSWERED
  onNext,
  onLockChange,      // remonte au parent l'état de verrouillage de la nav basse
  qualityKey,        // preset qualité vidéo (DEFAULT_VIDEO_QUALITY si absent)
  orientation,       // 'paysage' | 'portrait' (DEFAULT_VIDEO_ORIENTATION si absent)
  showcase = false,
  uploadVideo,
  guestVideoUrl,
}) {
  const [subState, setSubState] = useState(existingVideoId ? S.ANSWERED : S.INTRO);
  const [countdown, setCountdown] = useState(question.countdown ?? 3);
  const [uploadProgress, setUploadProgress] = useState(0);   // 0-1
  const [uploadError, setUploadError] = useState(null);
  const [uploadAttempt, setUploadAttempt] = useState(0);

  const videoPreviewRef = useRef(null); // <video> pour le preview caméra (intro)
  const videoBlobRef    = useRef(null); // <video> pour le preview blob (preview)
  const retryTimerRef   = useRef(null);

  const recorder = useMediaRecorder({ maxDuration: question.max_duration ?? 60, qualityKey, orientation });

  // ── Intro : attacher le preview caméra ──────────────────────────────────────
  useEffect(() => {
    if (showcase) return; // vitrine : jamais de getUserMedia
    if (subState === S.INTRO && recorder.status === REC_STATUS.IDLE) {
      recorder.requestPermission();
    }
  }, [subState, showcase]);

  // V2.6 : caméra live aussi en RECORDING (le flux getUserMedia reste actif).
  // attachPreview ne dépend que de streamRef — pas du statut READY/RECORDING.
  useEffect(() => {
    if (showcase) return;
    const inLiveState = subState === S.INTRO || subState === S.RECORDING;
    const streamActive = recorder.status === REC_STATUS.READY || recorder.status === REC_STATUS.RECORDING;
    if (inLiveState && streamActive && videoPreviewRef.current) {
      recorder.attachPreview(videoPreviewRef.current);
    }
  }, [subState, recorder.status, showcase]);

  // ── Countdown → démarrer l'enregistrement ───────────────────────────────────
  useEffect(() => {
    if (showcase) return;
    if (subState !== S.COUNTDOWN) return;
    if (countdown <= 0) {
      recorder.startRecording();
      setSubState(S.RECORDING);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [subState, countdown, showcase]);

  // ── Enregistrement terminé (auto-stop ou stop manuel) → preview ─────────────
  useEffect(() => {
    if (showcase) return;
    if (subState === S.RECORDING && recorder.status === REC_STATUS.STOPPED) {
      setSubState(S.PREVIEW);
    }
  }, [subState, recorder.status, showcase]);

  // ── Upload avec retry backoff ────────────────────────────────────────────────
  async function startUpload(attempt = 1) {
    if (showcase) return;
    setUploadAttempt(attempt);
    setUploadError(null);
    setUploadProgress(0);
    setSubState(S.UPLOADING);

    try {
      await uploadVideo({
        sessionId,
        questionId: question.id,
        questionText: question.text,
        blob: recorder.blob,
        mimeType: recorder.mimeType,
        onProgress: setUploadProgress,
      });
      onNext(); // succès → question suivante
    } catch (err) {
      if (attempt < 5) {
        const delay = retryDelay(attempt);
        retryTimerRef.current = setTimeout(() => startUpload(attempt + 1), delay);
        setUploadError(`Tentative ${attempt}/5 échouée. Nouvel essai dans ${Math.round(delay / 1000)} s…`);
      } else {
        setUploadError('L\'upload a échoué après 5 tentatives.');
      }
    }
  }

  // Nettoyage timer retry au démontage
  useEffect(() => {
    return () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); };
  }, []);

  // ── Verrouillage de la barre de navigation basse ─────────────────────────────
  // Pendant countdown/recording/upload, on ne doit pas changer de question.
  // On remonte l'info au parent (GuestPage) qui passe `locked` à QuestionNav.
  const navLocked = subState === S.COUNTDOWN || subState === S.RECORDING || subState === S.UPLOADING;
  useEffect(() => {
    onLockChange?.(navLocked);
  }, [navLocked, onLockChange]);

  // ── Rendu selon sous-état ────────────────────────────────────────────────────
  // Plus de header de progression ici : la barre basse (QuestionNav) porte
  // désormais « Question X / N » + la barre de remplissage (design/parcours-invite.md).

  if (subState === S.ANSWERED) {
    return (
      <div className="screen screen--recording">
        <h2 className="rec__question">{question.text}</h2>
        <div className="rec__preview-wrap">
          {/* Lecture de la réponse enregistrée — Range-aware côté serveur → scrubbing */}
          <video
            className="rec__blob-video"
            src={guestVideoUrl(sessionId, question.id)}
            controls
            playsInline
          />
        </div>
        <div className="rec__actions">
          <button className="btn btn--secondary" onClick={() => {
            recorder.resetRecording();
            setSubState(S.INTRO);
          }}>
            Refaire cette réponse
          </button>
          <button className="btn btn--primary" onClick={onNext}>
            Garder ✓
          </button>
        </div>
      </div>
    );
  }

  if (subState === S.INTRO) {
    const cameraReady = !showcase && recorder.status === REC_STATUS.READY;
    const si = recorder.streamSettings;
    return (
      <div className="screen screen--recording">
        <h2 className="rec__question">{question.text}</h2>
        <p className="text--muted rec__duration-hint">
          Durée max : {question.max_duration ?? 60} s
        </p>
        {/* Preview caméra miroir (transform scaleX(-1) dans le CSS).
            Le cadre suit l'orientation enregistrée : sans ça, object-fit:cover
            montrerait à l'invité un cadrage différent de la vidéo produite. */}
        <div className={`rec__camera-wrap rec__camera-wrap--${orientation === 'portrait' ? 'portrait' : 'paysage'}`}>
          {showcase ? (
            <div className="rec__camera-preview rec__camera-preview--placeholder" data-color-target="surface-alt">
              🎥
            </div>
          ) : recorder.error ? (
            <p className="text--error">{recorder.error}</p>
          ) : (
            <video
              ref={videoPreviewRef}
              className="rec__camera-preview"
              muted
              autoPlay
              playsInline
            />
          )}
        </div>
        {cameraReady && (
          <div style={{ fontSize: '11px', fontFamily: 'monospace', textAlign: 'center', opacity: 0.7, margin: '4px 0' }}>
            {si?.width && si?.height ? `${si.width}×${si.height}${si.frameRate ? ` · ${si.frameRate}fps` : ''}` : '?×?'}
            {` · ${recorder.mimeType.split(';')[0].replace('video/', '')}`}
            {si?.orientationMismatch && (
              <span className="text--error"> · ⚠ caméra en {si.orientation}</span>
            )}
          </div>
        )}
        <div className="rec__actions">
          <button
            className="btn btn--record btn--large"
            onClick={() => {
              if (showcase) return;
              setCountdown(question.countdown ?? 3);
              setSubState(S.COUNTDOWN);
            }}
            disabled={showcase || !cameraReady}
          >
            ● Commencer
          </button>
        </div>
      </div>
    );
  }

  if (subState === S.COUNTDOWN) {
    return (
      <div className="screen screen--center">
        <h2 className="rec__question">{question.text}</h2>
        <div className="countdown__number" aria-live="assertive">{countdown || '▶'}</div>
        <p className="text--muted">Préparez-vous…</p>
      </div>
    );
  }

  if (subState === S.RECORDING) {
    const progress = (recorder.duration / (question.max_duration ?? 60));
    const s = recorder.streamSettings;
    const resText = (s && s.width && s.height) ? `${s.width}×${s.height}` : null;
    return (
      <div className="screen screen--recording">
        <h2 className="rec__question">{question.text}</h2>
        <div className="rec__live-indicator" aria-live="polite">
          <span className="rec__dot rec__dot--blink" aria-hidden="true" /> REC
          &nbsp;&nbsp;{formatDuration(recorder.duration)}
          {resText && <>&nbsp;&nbsp;<span style={{ fontSize: '11px', opacity: 0.85, fontFamily: 'monospace' }}>{resText}</span></>}
        </div>
        {/* Caméra live pendant l'enregistrement — l'invité se voit (V2.6).
            playsInline + muted obligatoires pour Safari (invariant §11.5). */}
        <div className="rec__camera-wrap">
          <video
            ref={videoPreviewRef}
            className="rec__camera-preview"
            muted
            autoPlay
            playsInline
          />
        </div>
        <div className="rec__progress-bar rec__progress-bar--recording">
          <div className="rec__progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <button className="btn btn--stop btn--large" onClick={() => recorder.stopRecording()}>
          ■ Stop
        </button>
      </div>
    );
  }

  if (subState === S.PREVIEW) {
    return (
      <div className="screen screen--recording">
        <h2 className="rec__question">{question.text}</h2>
        <div className="rec__preview-wrap">
          {/* playsInline obligatoire pour Safari — invariant §11.5 */}
          <video
            ref={videoBlobRef}
            className="rec__blob-video"
            src={recorder.blobUrl}
            controls
            playsInline
          />
        </div>
        <div className="rec__actions">
          <button className="btn btn--secondary" onClick={() => {
            recorder.resetRecording();
            setSubState(S.INTRO);
          }}>
            Recommencer
          </button>
          <button className="btn btn--primary btn--large" onClick={() => startUpload(1)}>
            Parfait ✓
          </button>
        </div>
      </div>
    );
  }

  if (subState === S.UPLOADING) {
    const pct = Math.round(uploadProgress * 100);
    const isFinalError = uploadError && uploadAttempt >= 5;
    return (
      <div className="screen screen--center">
        <h2 className="rec__question">{question.text}</h2>
        {!isFinalError ? (
          <>
            <p className="text--muted">
              {uploadAttempt > 1 ? uploadError : `Envoi en cours… ${pct} %`}
            </p>
            <div className="upload-progress">
              <div className="upload-progress__bar">
                <div
                  className="upload-progress__fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="upload-progress__label">{pct} %</span>
            </div>
          </>
        ) : (
          <>
            <p className="text--error">{uploadError}</p>
            <div className="rec__actions">
              <button className="btn btn--secondary" onClick={() => {
                recorder.resetRecording();
                setSubState(S.INTRO);
              }}>
                Recommencer
              </button>
              <button className="btn btn--primary" onClick={() => startUpload(1)}>
                Réessayer l'upload
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return null;
}
