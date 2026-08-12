import React, { useState, useEffect, useCallback } from 'react';
import { api, getRole } from '../api/client.js';

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

// Assignation d'une borne physique (Phase B) à cet événement — même logique
// que BornePanel de l'onglet Bornes (assignable = toutes les bornes moins
// celles déjà assignées), en miroir depuis la fiche événement.
//
// /api/admin/bornes* est réservé superuser (comme la gestion des tokens et
// preview/start-stop) : un client propriétaire ne doit ni tenter l'appel (403
// avalé en silence, section vide) ni voir des contrôles qui échoueraient
// systématiquement. Il garde une vue lecture seule des bornes déjà assignées.
function BorneAssignment({ eventId, bornes, onChange }) {
  const isSuperuser = getRole() === 'superuser';
  const [allBornes, setAllBornes] = useState([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isSuperuser) return;
    api.listBornes().then(setAllBornes).catch(() => {});
  }, [isSuperuser]);

  const assignedIds = new Set(bornes.map((b) => b.id));
  const assignable = allBornes.filter((b) => !assignedIds.has(b.id));

  async function handleAssign(e) {
    e.preventDefault();
    if (!selected) return;
    setError('');
    try {
      await api.assignBorneEvent(selected, eventId);
      setSelected('');
      await onChange?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUnassign(borneId) {
    setError('');
    try {
      await api.unassignBorneEvent(borneId, eventId);
      await onChange?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      {error && <p className="error-msg">{error}</p>}
      {bornes.length === 0 ? (
        <p className="text--muted">Aucune borne physique assignée.</p>
      ) : (
        <ul className="sync-event-list">
          {bornes.map((b) => (
            <li key={b.id} className="sync-event-item">
              <span>{b.name}{b.location ? ` — ${b.location}` : ''}</span>
              {isSuperuser && (
                <button className="btn btn--ghost btn--sm" onClick={() => handleUnassign(b.id)}>Retirer</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isSuperuser && (
        <form onSubmit={handleAssign} className="inline-form" style={{ marginTop: '8px' }}>
          <select className="admin-input" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Assigner une borne…</option>
            {assignable.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="btn btn--secondary btn--sm" type="submit" disabled={!selected}>Assigner</button>
        </form>
      )}
    </>
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

  const { tokens, bornes, jobs, sync_log } = info;
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
              onClick={async () => {
                if (confirm('Valider la configuration ? Le contenu (questions, design) sera gelé et la borne réelle pourra se connecter.')) {
                  await onStatusChange?.('ready');
                  load();
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
            <button
              className="btn btn--ghost"
              onClick={async () => {
                await onStatusChange?.('preview');
                load();
              }}
            >
              Retour en preview
            </button>
          </div>
        )}
      </section>

      {/* Tokens de borne (essai/legacy — token = événement) */}
      <section className="panel-section">
        <h3 className="panel-section__title">Tokens de borne</h3>
        {tokens.length === 0 ? (
          <p className="text--muted">Aucun token généré pour cet événement.</p>
        ) : (
          <ul className="sync-event-list">
            {tokens.map((t) => (
              <li key={t.id} className="sync-event-item">
                <span>
                  {t.label ?? '(sans label)'}
                  <span className={`status-badge ${t.is_preview ? 'status-badge--draft' : 'status-badge--ready'}`} style={{ marginLeft: '8px' }}>
                    {t.is_preview ? 'Essai' : 'Réel'}
                  </span>
                </span>
                <span className="text--muted">{formatDate(t.last_seen_at) ?? 'jamais vu'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Bornes physiques assignées (Phase B — identité machine persistante) */}
      <section className="panel-section">
        <h3 className="panel-section__title">Bornes physiques</h3>
        <BorneAssignment eventId={ev.id} bornes={bornes} onChange={load} />
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
