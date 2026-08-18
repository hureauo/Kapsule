import React, { useState } from 'react';
import { api } from '../../api/client.js';

// onSuccess(token) : le composant parent décide où stocker le token
// (admin_token pour /admin, tech_token pour /borne). Code à 6 chiffres
// partagé (event_meta.admin_pin sur /admin, tech_pin sur /borne) — pas de
// compte nominatif pour ces rôles, et plus de mot de passe alternatif
// (TECH_PASSWORD retiré, PROJET.md §11.30 : le pont avant le premier pull se
// fait désormais via la session ouverte par POST /sync/onboarding/pair,
// cf. OnboardingScreen).
export default function AdminLogin({ onSuccess, title = 'Administration' }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.loginPin(pin);
      const accepted = onSuccess(data.token);
      if (accepted === false) setError('Accès refusé : droits insuffisants.');
    } catch {
      setError('Code incorrect.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login screen screen--center">
      <h2 className="screen__title">{title}</h2>
      <form onSubmit={handleSubmit} className="name-form">
        <input
          className="name-form__input"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoFocus
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
          placeholder="Code à 6 chiffres"
          disabled={loading}
          style={{ textAlign: 'center', letterSpacing: '4px', fontSize: '1.5rem' }}
        />
        {error && <p className="text--error" role="alert">{error}</p>}
        <button
          className="btn btn--primary btn--large"
          type="submit"
          disabled={loading || pin.length !== 6}
        >
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
