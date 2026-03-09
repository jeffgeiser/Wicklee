import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        // Dev-mode proxy: forwards /api and /ws to the local Sentinel on 7700
        // so `npm run dev` works alongside `cargo run` without CORS issues.
        proxy: {
          // Auth routes go to the cloud backend (port 8080 locally).
          // Must be listed before the generic /api rule so Vite matches it first.
          '/api/auth': { target: 'http://localhost:8080', changeOrigin: true },
          '/api': 'http://localhost:7700',
          '/ws':  { target: 'ws://localhost:7700', ws: true },
        },
      },
      build: {
        // Output directly into the agent crate so RustEmbed picks it up at
        // compile time via #[folder = "frontend/dist"].
        outDir: 'agent/frontend/dist',
        emptyOutDir: true,
        // Dashboard embeds Recharts + React; single-chunk is fine for a local
        // binary where there's no CDN or HTTP/2 multiplexing benefit to splitting.
        chunkSizeWarningLimit: 1000,
      },
      plugins: [tailwindcss(), react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
