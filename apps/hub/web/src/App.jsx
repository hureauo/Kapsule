import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated, getRole } from './api/client.js';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import EventsPage from './pages/EventsPage.jsx';
import EventDetailPage from './pages/EventDetailPage.jsx';
import DesignsPage from './pages/DesignsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

function RequireAuth({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

function RequireAdmin({ children }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />;
  if (getRole() !== 'superuser') return <Navigate to="/events" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/admin" element={<RequireAdmin><AdminPage /></RequireAdmin>} />
        <Route path="/events" element={<RequireAuth><EventsPage /></RequireAuth>} />
        <Route path="/events/:id" element={<RequireAuth><EventDetailPage /></RequireAuth>} />
        <Route path="/designs" element={<RequireAuth><DesignsPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to={isAuthenticated() ? (getRole() === 'superuser' ? '/admin' : '/events') : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
