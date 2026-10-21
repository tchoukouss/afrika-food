import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // En développement, l'API est servie via le même domaine : le cookie de
    // session reste « same-site » et aucune configuration CORS n'est nécessaire.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
