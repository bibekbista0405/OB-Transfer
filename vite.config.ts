import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    allowedHosts: ['localhost', '127.0.0.1'],
    // The application server owns the HTTP/HMR socket in development.
    // This avoids Vite opening a separate HMR WebSocket, which would
    // otherwise require a second CSP connect-src exception.
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
