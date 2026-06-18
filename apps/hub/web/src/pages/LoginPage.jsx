import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveToken, getRole } from '../api/client.js';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.login(email, password);
      saveToken(data.token);
      navigate(getRole() === 'admin' ? '/admin' : '/events', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Kapsule Hub</h1>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="field-label">
            Email
            <input
              type="email"
              className="hub-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="field-label">
            Mot de passe
            <input
              type="password"
              className="hub-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <p className="error-msg">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  );
}
