import React, { useState } from 'react';
import { LIMITS } from '@kapsule/core';

// createSession(name) → Promise<{id}> : injecté par l'appelant (borne :
// api.createSession réel ; aperçu Hub : pas d'appel réseau, le submit peut
// rester no-op) — jamais importé en dur ici (designUI, injection de dépendances).
export default function NameInput({ event, onSession, onBack, onClosed, createSession }) {
  const [name, setName] = useState('');
  const [consented, setConsented] = useState(false); // non pré-cochée (RGPD obligatoire)
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false); // popup « En savoir plus »

  const consentText = event?.consent_text ??
    'J\'accepte que mes vidéos soient enregistrées et transmises à l\'organisateur.';
  // name_prompt vient de GET /event (déjà résolu avec son défaut) — design/parcours-invite.md §11
  const namePrompt = event?.name_prompt ?? 'Comment vous appelez-vous ?';

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Merci d\'entrer votre prénom.'); return; }
    if (trimmed.length > LIMITS.GUEST_NAME_MAX) {
      setError(`Prénom trop long (${LIMITS.GUEST_NAME_MAX} caractères max).`);
      return;
    }
    if (!consented) { setError('Vous devez accepter le consentement pour continuer.'); return; }

    setLoading(true);
    setError('');
    try {
      const session = await createSession(trimmed); // envoie consent: true
      onSession(session.id, trimmed);
    } catch (err) {
      // 409 event_closed : l'admin a clôturé pendant que l'invité remplissait son prénom
      if (err.status === 409 && onClosed) { onClosed(); return; }
      setError(err.message ?? 'Erreur lors de la création de la session.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen screen--name">
      <h2 className="screen__title">{namePrompt}</h2>

      <form className="name-form" onSubmit={handleSubmit}>
        <input
          className="name-form__input"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          placeholder="Votre prénom"
          maxLength={LIMITS.GUEST_NAME_MAX}
          disabled={loading}
        />

        {/* Bloc consentement RGPD — texte scrollable + bouton détail + case à cocher tactile */}
        <div className="consent-block">
          <div className="consent-block__text" role="region" aria-label="Texte de consentement">
            {consentText}
          </div>

          {/* Bouton « En savoir plus » — ouvre la popup de détail (V2.4) */}
          {event?.consent_details && (
            <button
              type="button"
              className="btn btn--ghost consent-block__details-btn"
              onClick={() => setDetailsOpen(true)}
            >
              En savoir plus
            </button>
          )}

          <label className="consent-block__label">
            <input
              className="consent-block__checkbox"
              type="checkbox"
              checked={consented}
              onChange={(e) => { setConsented(e.target.checked); setError(''); }}
              disabled={loading}
            />
            <span className="consent-block__caption">J'accepte</span>
          </label>
        </div>

        {error && <p className="text--error" role="alert">{error}</p>}

        {/* Continuer désactivé tant que la case n'est pas cochée */}
        <button
          className="btn btn--primary btn--large"
          type="submit"
          disabled={!consented || loading}
        >
          {loading ? 'Connexion…' : 'Continuer'}
        </button>
      </form>

      <button className="btn btn--ghost" onClick={onBack} disabled={loading}>
        ← Retour
      </button>

      {/* Popup « En savoir plus » — informatif, un seul bouton Fermer (V2.4) */}
      {detailsOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="En savoir plus">
          <div className="modal consent-details-modal">
            <h3 className="modal__title">En savoir plus</h3>
            <div className="consent-details-modal__body">
              {event.consent_details}
            </div>
            <div className="modal__actions">
              <button
                className="btn btn--primary"
                onClick={() => setDetailsOpen(false)}
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
