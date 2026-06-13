import React, { useState } from 'react';
import { api } from '../../api/client.js';
import { LIMITS } from '@kapsule/core';

export default function NameInput({ event, onSession, onBack }) {
  const [name, setName] = useState('');
  const [consented, setConsented] = useState(false); // non pré-cochée (RGPD obligatoire)
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const consentText = event?.consent_text ??
    'J\'accepte que mes vidéos soient enregistrées et transmises à l\'organisateur.';

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
      const session = await api.createSession(trimmed); // envoie consent: true
      onSession(session.id, trimmed);
    } catch (err) {
      setError(err.message ?? 'Erreur lors de la création de la session.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen screen--name">
      <h2 className="screen__title">Comment vous appelez-vous ?</h2>

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

        {/* Bloc consentement RGPD — texte scrollable + case à cocher tactile */}
        <div className="consent-block">
          <div className="consent-block__text" role="region" aria-label="Texte de consentement">
            {consentText}
          </div>
          <label className="consent-block__label">
            <input
              className="consent-block__checkbox"
              type="checkbox"
              checked={consented}
              onChange={(e) => { setConsented(e.target.checked); setError(''); }}
              disabled={loading}
            />
            <span className="consent-block__caption">
              J'accepte que mes vidéos soient enregistrées et transmises à l'organisateur
            </span>
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
    </div>
  );
}
