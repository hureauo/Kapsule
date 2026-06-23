import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveToken, getRole } from '../api/client.js';

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotMsg, setForgotMsg] = useState(''); // message générique après demande
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.login(email, password);
      saveToken(data.token);
      navigate(getRole() === 'superuser' ? '/admin' : '/events', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError('');
    setForgotMsg('');
    setLoading(true);
    try {
      const data = await api.forgotPassword(email);
      // Le backend renvoie toujours un message générique (anti-énumération) : on l'affiche tel quel.
      setForgotMsg(data.message ?? 'Si cette adresse correspond à un compte, un email vient d\'être envoyé.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError('');
    setForgotMsg('');
    setPassword('');
  }

  if (mode === 'forgot') {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Mot de passe oublié</h1>
          {forgotMsg ? (
            <>
              <p className="text--muted" style={{ marginBottom: '1rem' }}>{forgotMsg}</p>
              <button className="btn btn--primary" onClick={() => switchMode('login')}>
                Retour à la connexion
              </button>
            </>
          ) : (
            <form onSubmit={handleForgot} className="login-form">
              <p className="text--muted" style={{ marginBottom: '0.5rem' }}>
                Saisissez votre email : si un compte existe, vous recevrez un lien de réinitialisation.
              </p>
              <label className="field-label">
                Email
                <input
                  type="email"
                  name="email"
                  id="forgot-email"
                  autoComplete="username"
                  className="hub-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              </label>
              {error && <p className="error-msg">{error}</p>}
              <button type="submit" className="btn btn--primary" disabled={loading}>
                {loading ? 'Envoi…' : 'Envoyer le lien'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => switchMode('login')}>
                Annuler
              </button>
            </form>
          )}
        </div>
      </div>
    );
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
              name="email"
              id="login-email"
              autoComplete="username"
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
              name="password"
              id="login-password"
              autoComplete="current-password"
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
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ marginTop: '0.75rem' }}
          onClick={() => switchMode('forgot')}
        >
          Mot de passe oublié ?
        </button>
      </div>
    </div>
  );
}
