import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './api/client.js';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import EventsPage from './pages/EventsPage.jsx';
import EventDetailPage from './pages/EventDetailPage.jsx';

function RequireAuth({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/events" element={<RequireAuth><EventsPage /></RequireAuth>} />
        <Route path="/events/:id" element={<RequireAuth><EventDetailPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to={isAuthenticated() ? '/events' : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
