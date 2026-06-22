import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveToken } from '../api/client.js';

export default function RegisterPage() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Lien invalide</h1>
          <p className="text--muted">Ce lien d'enregistrement est invalide ou a expiré.</p>
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit faire au moins 8 caractères.');
      return;
    }
    setLoading(true);
    try {
      await api.setPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err.status === 409) setError("Ce lien a déjà été utilisé. Demandez un nouveau lien à l'administrateur.");
      else if (err.status === 410) setError("Ce lien a expiré. Demandez un nouveau lien à l'administrateur.");
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Mot de passe créé</h1>
          <p className="text--muted">Votre compte est actif. Vous pouvez maintenant vous connecter.</p>
          <button className="btn btn--primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/login', { replace: true })}>
            Se connecter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Créer votre mot de passe</h1>
        <p className="text--muted" style={{ marginBottom: '1rem' }}>
          Choisissez un mot de passe pour activer votre compte Kapsule.
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="field-label">
            Mot de passe
            <input
              type="password"
              name="new-password"
              id="register-password"
              autoComplete="new-password"
              className="hub-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
              minLength={8}
            />
          </label>
          <label className="field-label">
            Confirmer le mot de passe
            <input
              type="password"
              name="confirm-password"
              id="register-confirm"
              autoComplete="new-password"
              className="hub-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          {error && <p className="error-msg">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Enregistrement…' : 'Créer mon mot de passe'}
          </button>
        </form>
      </div>
    </div>
  );
}
