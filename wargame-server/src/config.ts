import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// wargame-server/.env (vedi .env.example): le variabili già impostate nell'ambiente hanno la precedenza
// (non nei test: devono dare lo stesso risultato qualunque sia la configurazione locale)
if (!process.env.VITEST && existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

export const config = {
  port: Number(process.env.WARGAME_PORT ?? 8787),
  host: process.env.WARGAME_HOST ?? '127.0.0.1',
  dataDir: process.env.WARGAME_DATA_DIR ?? path.join(root, 'data', 'campaigns'),
  corsOrigin: process.env.WARGAME_CORS_ORIGIN ?? 'http://localhost:5173',
  mock: process.env.WARGAME_MOCK === '1',
  /** WARGAME_ALLOW_OFFLINE=1: ▶ anche con i modelli irraggiungibili (turni con gli ordini di dottrina) */
  allowOffline: process.env.WARGAME_ALLOW_OFFLINE === '1',
};

/**
 * Cadenza predefinita degli agenti per le campagne nuove (WARGAME_MINOR_EVERY, WARGAME_REFLECT_EVERY; 1 = sempre)
 * e lettere IA di iniziativa per turno (WARGAME_LETTERS_PER_TURN, predefinito 3; 0 = solo risposte al giocatore).
 */
export const cadenceDefaults = () => ({
  minorEvery: Math.max(0, Number(process.env.WARGAME_MINOR_EVERY ?? 1) || 0),
  reflectEvery: Math.max(1, Number(process.env.WARGAME_REFLECT_EVERY ?? 1) || 1),
  lettersPerTurn: Math.max(0, Math.floor(Number(process.env.WARGAME_LETTERS_PER_TURN ?? 3) || 0)),
});

export const AGENT_ROLES = ['faction_major', 'faction_minor', 'gm_narrator', 'intel_analyst', 'order_parser', 'reflection', 'repair', 'diplomat'] as const;
type RoleCfg = { model: string; temperature: number; maxTokens: number; timeoutMs: number };

/**
 * Modello per ruolo agente (alias/combo di OmniRoute), copiato nella campagna alla creazione.
 * LLM_MODEL = default per tutti; LLM_MODEL_<RUOLO> = override (es. LLM_MODEL_FACTION_MAJOR).
 * Il ruolo diplomat (lettere) senza LLM_MODEL_DIPLOMAT usa il modello di faction_major.
 */
export function llmDefaults(): Record<(typeof AGENT_ROLES)[number], RoleCfg> {
  const env = process.env;
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return Object.fromEntries(AGENT_ROLES.map((r) => {
    const R = r.toUpperCase();
    return [r, {
      model: env[`LLM_MODEL_${R}`] ?? (r === 'diplomat' ? env.LLM_MODEL_FACTION_MAJOR : undefined) ?? env.LLM_MODEL ?? 'default',
      temperature: num(`LLM_TEMPERATURE_${R}`, r === 'gm_narrator' ? 0.7 : r === 'diplomat' ? 0.6 : r.startsWith('faction') ? 0.5 : 0.2),
      maxTokens: num(`LLM_MAX_TOKENS_${R}`, r.startsWith('faction') ? 3000 : r === 'diplomat' ? 1200 : 2000),
      timeoutMs: num('LLM_TIMEOUT_MS', 180_000),
    }];
  })) as Record<(typeof AGENT_ROLES)[number], RoleCfg>;
}
