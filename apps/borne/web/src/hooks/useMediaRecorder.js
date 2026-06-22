import { useCallback, useEffect, useRef, useState } from 'react';
import { VIDEO_QUALITY, DEFAULT_VIDEO_QUALITY, AUDIO_BITRATE } from '@kapsule/core';

// Ordre de préférence MIME :
// - Safari/iOS ne supporte que video/mp4 + codecs AVC/AAC (pas webm)
// - Chrome/Firefox supportent webm vp9 ou vp8
// isTypeSupported() probe à la volée — le premier supporté est utilisé.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2', // Safari iOS — codec explicite
  'video/mp4',                         // Safari fallback sans codec
  'video/webm;codecs=vp9,opus',        // Chrome/Firefox préféré
  'video/webm;codecs=vp8,opus',        // Chrome fallback
  'video/webm',                        // dernier recours
];

function detectMimeType() {
  if (typeof MediaRecorder === 'undefined') return 'video/mp4';
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return 'video/mp4'; // fallback ultime si aucun supporté (ne devrait pas arriver)
}

// États possibles du hook
export const REC_STATUS = {
  IDLE: 'idle',           // pas de stream
  REQUESTING: 'requesting', // getUserMedia en cours
  READY: 'ready',         // stream actif, prêt à enregistrer
  RECORDING: 'recording', // enregistrement en cours
  STOPPED: 'stopped',     // blob disponible
  ERROR: 'error',
};

export default function useMediaRecorder({ maxDuration = 60, qualityKey = DEFAULT_VIDEO_QUALITY } = {}) {
  const quality = VIDEO_QUALITY[qualityKey] ?? VIDEO_QUALITY[DEFAULT_VIDEO_QUALITY];
  const [status, setStatus] = useState(REC_STATUS.IDLE);
  const [error, setError] = useState(null);
  const [duration, setDuration] = useState(0);   // secondes écoulées
  const [blob, setBlob] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [mimeType] = useState(() => detectMimeType());

  const [accumulatedBytes, setAccumulatedBytes] = useState(0);  // octets encodés (chunks)
  const [streamSettings, setStreamSettings]     = useState(null); // résolution/fps effective

  const streamRef        = useRef(null);
  const recorderRef      = useRef(null);
  const chunksRef        = useRef([]);
  const timerRef         = useRef(null);
  const durationRef      = useRef(0);
  const accBytesRef      = useRef(0); // copie ref pour le handler ondataavailable

  // Libère le stream caméra et arrête le chrono
  const releaseStream = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // Révoque l'object URL précédent pour éviter les fuites mémoire
  const revokeBlobUrl = useCallback(() => {
    setBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // Nettoyage complet (appelé au démontage ou reset)
  const cleanup = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      // Neutralise onstop avant stop() pour éviter que le handler asynchrone
      // ressuscite blob/blobUrl après le nettoyage (fuite mémoire)
      recorderRef.current.onstop = null;
      recorderRef.current.ondataavailable = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    releaseStream();
    revokeBlobUrl();
    setBlob(null);
    setDuration(0);
    durationRef.current = 0;
    setAccumulatedBytes(0);
    accBytesRef.current = 0;
    setStreamSettings(null);
    setError(null);
    setStatus(REC_STATUS.IDLE);
  }, [releaseStream, revokeBlobUrl]);

  // Démontage du composant parent → libère toujours la caméra
  useEffect(() => () => { cleanup(); }, [cleanup]);

  // ── Actions exposées ────────────────────────────────────────────────────────

  const requestPermission = useCallback(async () => {
    if (status !== REC_STATUS.IDLE && status !== REC_STATUS.ERROR) return;
    setStatus(REC_STATUS.REQUESTING);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: quality.width }, height: { ideal: quality.height } },
        audio: true,
      });
      streamRef.current = stream;
      // Lire la résolution et le codec effectifs que le navigateur a accordés.
      // getSettings() est synchrone une fois le stream actif.
      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        const s = vTrack.getSettings();
        const settings = { width: s.width, height: s.height, frameRate: s.frameRate ? Math.round(s.frameRate) : null };

        setStreamSettings(settings);
      }
      setStatus(REC_STATUS.READY);
    } catch (e) {
      // Messages distincts selon l'origine du refus (spec §8 — important pour l'invité)
      let msg;
      if (e.name === 'NotAllowedError') {
        msg = 'Accès à la caméra refusé. Autorisez l\'accès dans les réglages et rechargez la page.';
      } else if (e.name === 'NotFoundError') {
        msg = 'Aucune caméra détectée. Vérifiez que votre appareil dispose d\'une caméra.';
      } else {
        msg = `Erreur caméra : ${e.message ?? e.name}`;
      }
      setError(msg);
      setStatus(REC_STATUS.ERROR);
    }
  }, [status]);

  const startRecording = useCallback(() => {
    if (status !== REC_STATUS.READY) return;
    if (!streamRef.current) return;

    chunksRef.current = [];
    revokeBlobUrl();
    setBlob(null);
    setDuration(0);
    durationRef.current = 0;
    setAccumulatedBytes(0);
    accBytesRef.current = 0;

    const recorder = new MediaRecorder(streamRef.current, {
      mimeType,
      videoBitsPerSecond: quality.videoBitrate,
      audioBitsPerSecond: AUDIO_BITRATE,
    });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
        accBytesRef.current += e.data.size;
        setAccumulatedBytes(accBytesRef.current);

      }
    };

    recorder.onstop = () => {
      const recorded = new Blob(chunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(recorded);
      setBlob(recorded);
      setBlobUrl(url);
      // STOPPED positionné ici pour garantir que blob/blobUrl sont disponibles
      // dès que le statut change (onstop est asynchrone par rapport à .stop())
      setStatus(REC_STATUS.STOPPED);
    };

    // start(0) = pas d'interval natif ; on appelle requestData() depuis le timer
    // pour forcer un flush toutes les secondes (Chrome ignore start(1000)).
    recorder.start(0);
    recorderRef.current = recorder;
    setStatus(REC_STATUS.RECORDING);

    timerRef.current = setInterval(() => {
      durationRef.current += 1;
      setDuration(durationRef.current);
      // Flush forcé : récupère les données encodées depuis le dernier appel
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.requestData();
      }
      if (durationRef.current >= maxDuration) {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop();
        }
      }
    }, 1000);
  }, [status, mimeType, maxDuration, revokeBlobUrl]);

  const stopRecording = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    // Ne pas setStatus(STOPPED) ici : onstop le fera une fois le blob construit
    recorderRef.current.stop();
  }, []);

  // Réinitialise pour re-enregistrer (conserve le stream caméra actif)
  const resetRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null;
      recorderRef.current.ondataavailable = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    revokeBlobUrl();
    setBlob(null);
    setDuration(0);
    durationRef.current = 0;
    setAccumulatedBytes(0);
    accBytesRef.current = 0;
    setError(null);
    // Retour à READY si le stream est toujours actif, sinon IDLE
    setStatus(streamRef.current ? REC_STATUS.READY : REC_STATUS.IDLE);
  }, [revokeBlobUrl]);

  // Branche le flux live sur un élément <video> pour le preview caméra
  // Le <video> doit avoir muted + autoplay + playsInline (invariant Safari §11)
  const attachPreview = useCallback((videoEl) => {
    if (!videoEl || !streamRef.current) return;
    videoEl.srcObject = streamRef.current;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.play().catch(() => {}); // Safari peut nécessiter un play() explicite
  }, []);

  return {
    status,
    error,
    duration,
    blob,
    blobUrl,
    mimeType,
    streamSettings,    // { width, height, frameRate } effectifs accordés par le navigateur
    // Actions
    requestPermission,
    startRecording,
    stopRecording,
    resetRecording,
    cleanup,
    attachPreview,
  };
}
