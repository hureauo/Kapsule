import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@kapsule/guest-ui/guest.css';
import './styles/app.css';

createRoot(document.getElementById('root')).render(<App />);
