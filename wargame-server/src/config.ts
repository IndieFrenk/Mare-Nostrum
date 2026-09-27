import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.WARGAME_PORT ?? 8787),
  host: process.env.WARGAME_HOST ?? '127.0.0.1',
  dataDir: process.env.WARGAME_DATA_DIR ?? path.join(root, 'data', 'campaigns'),
  corsOrigin: process.env.WARGAME_CORS_ORIGIN ?? 'http://localhost:5173',
  mock: process.env.WARGAME_MOCK === '1',
};
