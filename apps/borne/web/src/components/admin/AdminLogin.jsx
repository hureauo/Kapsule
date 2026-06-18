import React, { useState } from 'react';
import { api } from '../../api/client.js';

// onSuccess(token) : le composant parent décide où stocker le token
// (admin_token pour /admin, tech_token pour /admin/tech)
export default function AdminLogin({ onSuccess, title = 'Administration' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.login(email || undefined, password);
      onSuccess(data.token);
    } catch {
      setError('Identifiants incorrects.');
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
        {error && <p className="text--error" role="alert">{error}</p>}
        <button className="btn btn--primary btn--large" type="submit" disabled={loading}>
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
