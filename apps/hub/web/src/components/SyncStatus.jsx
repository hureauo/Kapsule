import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';

const STATUS_ORDER = ['preview', 'ready', 'loaded', 'live', 'closed', 'pushed', 'processed', 'waiting'];

const STATUS_TIMELINE_LABEL = {
  preview: 'Preview', ready: 'Prêt', loaded: 'Chargé',
  live: 'En cours', closed: 'Terminé', pushed: 'Poussé',
  processed: 'Traité', waiting: 'En attente',
};

// Description pédagogique de chaque étape du cycle de vie d'un événement.
// Affichée sous le label dans la timeline pour expliquer « où on en est ».
const STATUS_TIMELINE_DESC = {
  preview: 'Phase d\'essai : on configure questions et design, et on teste sur la borne d\'essai.',
  ready: 'Configuration gelée (questions + design figés). La borne réelle peut désormais se connecter et récupérer le contenu.',
  loaded: 'La borne a récupéré la configuration et les médias : elle est prête pour l\'événement, hors ligne.',
  live: 'Événement en cours sur la borne : les invités enregistrent leurs vidéos.',
  closed: 'Événement terminé côté borne. Les vidéos attendent d\'être renvoyées au Hub.',
  pushed: 'La borne a renvoyé toutes les vidéos au Hub.',
  processed: 'Les vidéos ont été traitées côté Hub (transcodage, vignettes).',
  waiting: 'En attente d\'une action ou d\'un traitement complémentaire.',
};

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleString('fr-FR');
}

function StatusTimeline({ status, pulledAt, pushedAt, processedAt }) {
  const current = STATUS_ORDER.indexOf(status);
  return (
    <div className="sync-timeline">
      {STATUS_ORDER.map((s, i) => {
        const done = i <= current;
        const isCurrent = i === current;
        let date = null;
        if (s === 'loaded' && pulledAt) date = formatDate(pulledAt);
        if (s === 'pushed' && pushedAt) date = formatDate(pushedAt);
        if (s === 'processed' && processedAt) date = formatDate(processedAt);
        return (
          <div
            key={s}
            className={`timeline-step${done ? ' timeline-step--done' : ''}${isCurrent ? ' timeline-step--current' : ''}`}
          >
            <span className="timeline-step__label">{STATUS_TIMELINE_LABEL[s] ?? s}</span>
            {date && <span className="timeline-step__date">{date}</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function SyncStatus({ event, frozen = false, onStatusChange }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!event?.id) return;
    try {
      const data = await api.getSyncInfo(event.id);
      setInfo(data);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [event?.id]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <p className="error-msg">{error}</p>;
  if (!info) return <p className="text--muted">Chargement…</p>;

  const { box, jobs, sync_log } = info;
  const ev = info.event;

  return (
    <div className="sync-status">
      {/* Timeline */}
      <section className="panel-section">
        <h3 className="panel-section__title">Progression</h3>
        <StatusTimeline
          status={ev.status}
          pulledAt={ev.pulled_at}
          pushedAt={ev.pushed_at}
          processedAt={ev.processed_at}
        />

        {/* Description de l'étape courante, en pleine largeur sous la timeline
            (la cellule de timeline est trop étroite pour un texte explicatif). */}
        {STATUS_TIMELINE_DESC[ev.status] && (
          <p className="sync-step-desc">
            <strong>{STATUS_TIMELINE_LABEL[ev.status] ?? ev.status}</strong> — {STATUS_TIMELINE_DESC[ev.status]}
          </p>
        )}

        {/* Action qui fait avancer le cycle de vie : on la place ici, sous la timeline,
            pour que le lien action → effet sur la progression soit explicite. */}
        {!frozen && ev.status === 'preview' && (
          <div className="sync-transition">
            <p className="text--muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Quand la configuration est testée et prête, validez-la : questions et design
              seront <strong>gelés</strong> (plus modifiables) et la <strong>borne réelle pourra
              se connecter</strong> pour récupérer le contenu. Vous pourrez revenir en preview tant
              que la borne n'a rien chargé.
            </p>
            <button
              className="btn btn--primary"
              onClick={() => {
                if (confirm('Valider la configuration ? Le contenu (questions, design) sera gelé et la borne réelle pourra se connecter.')) {
                  onStatusChange?.('ready');
                }
              }}
            >
              Valider la configuration
            </button>
          </div>
        )}
        {!frozen && ev.status === 'ready' && (
          <div className="sync-transition">
            <p className="text--muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Configuration gelée. Tant que la borne n'a pas chargé le contenu, vous pouvez
              revenir en preview pour modifier questions et design.
            </p>
            <button className="btn btn--ghost" onClick={() => onStatusChange?.('preview')}>
              Retour en preview
            </button>
          </div>
        )}
      </section>

      {/* Borne assignée */}
      <section className="panel-section">
        <h3 className="panel-section__title">Borne assignée</h3>
        {box ? (
          <dl className="sync-info">
            <dt>Nom</dt><dd>{box.name}</dd>
            <dt>Dernier contact</dt><dd>{formatDate(box.last_seen_at) ?? '—'}</dd>
          </dl>
        ) : (
          <p className="text--muted">Aucune borne assignée.</p>
        )}
      </section>

      {/* Jobs */}
      {jobs.total > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">
            Jobs de traitement — {jobs.done}/{jobs.total} terminés
            {jobs.failed > 0 && <span className="badge badge--error"> {jobs.failed} échoués</span>}
          </h3>
          <div className="table-scroll">
            <table className="sync-jobs-table responsive-table">
              <thead>
                <tr>
                  <th>Type</th><th>Vidéo</th><th>Statut</th><th>Fin</th>
                </tr>
              </thead>
              <tbody>
                {jobs.list.map(j => (
                  <tr key={j.id} className={`job-row job-row--${j.status}`}>
                    <td data-label="Type">{j.type}</td>
                    <td data-label="Vidéo" className="text--muted">{j.video_id ? j.video_id.slice(0, 8) + '…' : '—'}</td>
                    <td data-label="Statut"><span className={`status-badge status-badge--${j.status}`}>{j.status}</span></td>
                    <td data-label="Fin" className="text--muted">{formatDate(j.finished_at) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Sync log */}
      {sync_log.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">Journal de synchro (20 derniers)</h3>
          <div className="table-scroll">
            <table className="sync-log-table responsive-table">
              <thead>
                <tr><th>Date</th><th>Borne</th><th>Action</th><th>Détail</th></tr>
              </thead>
              <tbody>
                {sync_log.map(l => (
                  <tr key={l.id}>
                    <td data-label="Date" className="text--muted">{formatDate(l.created_at)}</td>
                    <td data-label="Borne">{l.box_name ?? '—'}</td>
                    <td data-label="Action"><code>{l.action}</code></td>
                    <td data-label="Détail" className="text--muted">
                      {l.detail ? JSON.stringify(JSON.parse(l.detail)) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
