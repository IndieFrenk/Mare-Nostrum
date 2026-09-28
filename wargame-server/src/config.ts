import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// wargame-server/.env (vedi .env.example): le variabili già impostate nell'ambiente hanno la precedenza
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

export const config = {
  port: Number(process.env.WARGAME_PORT ?? 8787),
  host: process.env.WARGAME_HOST ?? '127.0.0.1',
  dataDir: process.env.WARGAME_DATA_DIR ?? path.join(root, 'data', 'campaigns'),
  corsOrigin: process.env.WARGAME_CORS_ORIGIN ?? 'http://localhost:5173',
  mock: process.env.WARGAME_MOCK === '1',
};

export const AGENT_ROLES = ['faction_major', 'faction_minor', 'gm_narrator', 'intel_analyst', 'order_parser', 'reflection', 'repair'] as const;
type RoleCfg = { model: string; temperature: number; maxTokens: number; timeoutMs: number };

/**
 * Modello per ruolo agente (alias/combo di OmniRoute), copiato nella campagna alla creazione.
 * LLM_MODEL = default per tutti; LLM_MODEL_<RUOLO> = override (es. LLM_MODEL_FACTION_MAJOR).
 */
export function llmDefaults(): Record<(typeof AGENT_ROLES)[number], RoleCfg> {
  const env = process.env;
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return Object.fromEntries(AGENT_ROLES.map((r) => {
    const R = r.toUpperCase();
    return [r, {
      model: env[`LLM_MODEL_${R}`] ?? env.LLM_MODEL ?? 'default',
      temperature: num(`LLM_TEMPERATURE_${R}`, r === 'gm_narrator' ? 0.7 : r.startsWith('faction') ? 0.5 : 0.2),
      maxTokens: num(`LLM_MAX_TOKENS_${R}`, r.startsWith('faction') ? 3000 : 2000),
      timeoutMs: num('LLM_TIMEOUT_MS', 180_000),
    }];
  })) as Record<(typeof AGENT_ROLES)[number], RoleCfg>;
}
