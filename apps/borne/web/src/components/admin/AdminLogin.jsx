import React, { useState } from 'react';
import { api } from '../../api/client.js';

// onSuccess(token) : le composant parent décide où stocker le token
// (admin_token pour /admin, tech_token pour /borne)
// mode : 'pin' (6 chiffres, code partagé — event_meta.admin_pin sur /admin,
//   tech_pin sur /borne — pas de compte nominatif pour ces rôles) | 'password'
//   (mot de passe seul, fallback TECH_PASSWORD — actif uniquement tant qu'aucun
//   événement n'est actif, cf. middleware/auth.js)
export default function AdminLogin({ onSuccess, title = 'Administration', mode = 'password' }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = mode === 'pin'
        ? await api.loginPin(pin)
        : await api.login(undefined, password);
      const accepted = onSuccess(data.token);
      if (accepted === false) setError('Accès refusé : droits insuffisants.');
    } catch {
      setError(mode === 'pin' ? 'Code incorrect.' : 'Identifiants incorrects.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login screen screen--center">
      <h2 className="screen__title">{title}</h2>
      <form onSubmit={handleSubmit} className="name-form">
        {mode === 'pin' ? (
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
        ) : (
          <input
            className="name-form__input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            placeholder="Mot de passe"
            disabled={loading}
          />
        )}
        {error && <p className="text--error" role="alert">{error}</p>}
        <button
          className="btn btn--primary btn--large"
          type="submit"
          disabled={loading || (mode === 'pin' && pin.length !== 6)}
        >
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
