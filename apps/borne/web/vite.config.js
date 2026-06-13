import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // En dev : proxy /api/* vers le backend Express (port 3001)
    // En prod : Nginx fait ce proxy — le frontend ne connaît jamais l'adresse du backend
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
