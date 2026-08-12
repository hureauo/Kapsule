import React, { useState } from 'react';
import { api } from '../../api/client.js';

// onSuccess(token) : le composant parent décide où stocker le token
// (admin_token pour /admin, tech_token pour /borne)
// mode : 'pin' (6 chiffres, /admin — code partagé, pas de compte nominatif pour
//   ce rôle, cf. event_meta.admin_pin) | 'password' (email + mot de passe, /borne
//   — compte nominatif tech_borne, ou TECH_PASSWORD en mode autonome)
export default function AdminLogin({ onSuccess, title = 'Administration', mode = 'password' }) {
  const [email, setEmail] = useState('');
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
        : await api.login(email || undefined, password);
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
          <>
            <input
              className="name-form__input"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              placeholder="Email (vide en mode autonome)"
              disabled={loading}
            />
            <input
              className="name-form__input"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder="Mot de passe"
              disabled={loading}
            />
          </>
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
