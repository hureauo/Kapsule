import React, { useState } from 'react';
import { api, saveToken } from '../../api/client.js';

export default function AdminLogin({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.login(password);
      saveToken(data.token);
      onSuccess();
    } catch {
      setError('Mot de passe incorrect.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login screen screen--center">
      <h2 className="screen__title">Administration</h2>
      <form onSubmit={handleSubmit} className="name-form">
        <input
          className="name-form__input"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          placeholder="Mot de passe admin"
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
