import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const tunnelHost = (process.env.NGROK_HOST || '').trim().toLowerCase();
const allowedHosts = ['localhost', '127.0.0.1'];
if (tunnelHost && /^[a-z0-9.-]+$/.test(tunnelHost) && !tunnelHost.startsWith('.') && !tunnelHost.endsWith('.')) {
  allowedHosts.push(tunnelHost);
}

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    // Never use `true` here: allow only loopback and the explicitly configured tunnel hostname.
    allowedHosts,
    // The application server owns the HTTP/HMR socket in development.
    // This avoids Vite opening a separate HMR WebSocket, which would
    // otherwise require a second CSP connect-src exception.
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
