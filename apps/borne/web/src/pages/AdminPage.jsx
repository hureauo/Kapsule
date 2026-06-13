import React, { useState } from 'react';
import { api, saveToken, clearToken, isAuthenticated } from '../api/client.js';

function LoginForm({ onSuccess }) {
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
    } catch (err) {
      setError('Mot de passe incorrect.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen screen--center admin-login">
      <h2 className="screen__title">Administration</h2>
      <form onSubmit={handleSubmit} className="name-form">
        <input
          className="name-form__input"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          placeholder="Mot de passe admin"
        />
        {error && <p className="text--error">{error}</p>}
        <button className="btn btn--primary btn--large" type="submit" disabled={loading}>
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}

function AdminDashboard({ onLogout }) {
  return (
    <div className="screen admin-dashboard">
      <header className="admin-header">
        <h1 className="admin-header__title">Kapsule — Admin</h1>
        <button className="btn btn--secondary btn--small" onClick={onLogout}>
          Déconnexion
        </button>
      </header>
      <main className="admin-main">
        {/* Contenu admin implémenté en phase 1c */}
        <p className="text--muted">Interface admin — phase 1c</p>
      </main>
    </div>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(isAuthenticated());

  function handleLogout() {
    clearToken();
    setAuthed(false);
  }

  if (!authed) return <LoginForm onSuccess={() => setAuthed(true)} />;
  return <AdminDashboard onLogout={handleLogout} />;
}
