import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Variante "wargame": config minimale, separato da vite.config.ts (niente PWA, Sentry, pagine upstream).
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  publicDir: false,
  server: { port: 5173, open: process.env.CI ? false : '/wargame.html' },
  build: { outDir: 'dist-wargame', emptyOutDir: true, chunkSizeWarningLimit: 2500, // quasi tutto è maplibre-gl
    rollupOptions: { input: { wargame: resolve(__dirname, 'wargame.html') } } },
});
