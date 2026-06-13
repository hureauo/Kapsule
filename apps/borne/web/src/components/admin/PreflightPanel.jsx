import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

function CheckRow({ label, ok, detail }) {
  return (
    <div className={`preflight-row${ok === true ? ' preflight-row--ok' : ok === false ? ' preflight-row--fail' : ''}`}>
      <span className="preflight-row__icon">
        {ok === true ? '✅' : ok === false ? '❌' : '⏳'}
      </span>
      <div className="preflight-row__body">
        <span className="preflight-row__label">{label}</span>
        {detail && <span className="preflight-row__detail">{detail}</span>}
      </div>
    </div>
  );
}

export default function PreflightPanel() {
  const [preflight, setPreflight] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  // Test caméra — déclenché manuellement depuis l'appareil admin
  const [cameraStatus, setCameraStatus] = useState('idle'); // idle | testing | ok | fail
  const [cameraError, setCameraError]   = useState('');
  const [cameraStream, setCameraStream] = useState(null);
  const videoRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getPreflight(new Date().toISOString());
      setPreflight(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Nettoyage du flux caméra au démontage
  useEffect(() => {
    return () => {
      if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
    };
  }, [cameraStream]);

  // Branche le stream sur le <video> dès qu'il est monté dans le DOM
  // (le <video> n'existe que quand cameraStatus === 'ok', donc après le re-render)
  useEffect(() => {
    if (cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraStream]);

  async function handleTestCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
      setCameraStatus('idle');
      return;
    }
    setCameraStatus('testing');
    setCameraError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      setCameraStream(stream);
      setCameraStatus('ok');
    } catch (e) {
      setCameraStatus('fail');
      if (e.name === 'NotAllowedError') {
        setCameraError("Permission refusée — autoriser la caméra dans Safari.");
      } else if (e.name === 'NotFoundError') {
        setCameraError("Aucune caméra détectée sur cet appareil.");
      } else {
        setCameraError(e.message);
      }
    }
  }

  if (loading) return <p className="text--muted">Chargement…</p>;
  if (error)   return (
    <p className="text--error">
      {error}{' '}
      <button className="btn btn--small btn--secondary" onClick={load}>Réessayer</button>
    </p>
  );

  const cameraOk = cameraStatus === 'ok' ? true : cameraStatus === 'fail' ? false : null;

  return (
    <div className="preflight-panel">
      <div className="preflight-list">
        <CheckRow
          label="Événement configuré"
          ok={preflight.event.loaded}
          detail={preflight.event.loaded
            ? `Tiré le ${preflight.event.pulled_at ? new Date(preflight.event.pulled_at).toLocaleString('fr-FR') : '—'}`
            : 'Aucun événement actif — créez et activez un événement.'}
        />
        <CheckRow
          label="Questions"
          ok={preflight.questions_count > 0}
          detail={`${preflight.questions_count} question(s) activée(s)`}
        />
        <CheckRow
          label="Espace disque"
          ok={preflight.disk_ok}
          detail={preflight.disk_ok ? 'Suffisant (> 10 Go)' : 'Critique — moins de 10 Go disponibles !'}
        />
        <CheckRow
          label="Horloge synchronisée"
          ok={preflight.clock_ok}
          detail={preflight.clock_ok === true
            ? 'Écart < 2 min'
            : preflight.clock_ok === false
            ? 'Écart > 2 min — vérifiez le module RTC DS3231 et chrony.'
            : 'Non vérifié'}
        />
        <CheckRow
          label="Caméra"
          ok={cameraOk}
          detail={cameraStatus === 'idle'
            ? 'Cliquez « Tester la caméra » pour vérifier.'
            : cameraStatus === 'testing'
            ? "Demande d'accès…"
            : cameraStatus === 'ok'
            ? 'Accès accordé — aperçu actif.'
            : cameraError}
        />
      </div>

      {/* Aperçu caméra + bouton */}
      <div className="preflight-camera">
        {cameraStatus === 'ok' && (
          <video
            ref={videoRef}
            className="preflight-camera__preview"
            autoPlay
            muted
            playsInline
          />
        )}
        <button
          className={`btn btn--small ${cameraStatus === 'ok' ? 'btn--secondary' : 'btn--primary'}`}
          onClick={handleTestCamera}
          disabled={cameraStatus === 'testing'}
        >
          {cameraStatus === 'ok' ? 'Arrêter la caméra' : 'Tester la caméra'}
        </button>
      </div>

      <button className="btn btn--small btn--secondary preflight-refresh" onClick={load}>
        ↺ Actualiser
      </button>
    </div>
  );
}
