import { defineConfig } from '@playwright/test';

// e2e della variante wargame: server con LLM mock + Vite, su porte dedicate.
export default defineConfig({
  testDir: './e2e-wargame',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    screenshot: 'only-on-failure',
    // WebGL software: la mappa (e le query sui layer) funziona anche senza GPU
    launchOptions: { executablePath: process.env.WG_CHROMIUM_PATH || undefined, args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: [
    { command: 'npm --prefix wargame-server start', url: 'http://127.0.0.1:8788/api/wg/scenarios', reuseExistingServer: false, env: { WARGAME_MOCK: '1', WARGAME_PORT: '8788', WARGAME_DATA_DIR: 'wargame-server/data/e2e' } },
    { command: 'npx vite -c vite.wargame.config.ts --port 5174 --strictPort', url: 'http://127.0.0.1:5174/wargame.html', reuseExistingServer: false, env: { CI: '1', VITE_WARGAME_API: 'http://127.0.0.1:8788' } },
  ],
});
