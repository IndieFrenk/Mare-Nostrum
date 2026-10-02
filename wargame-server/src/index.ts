import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config, factionModeDefault } from './config.js';
import { OpenAiCompatProvider, type LlmProvider } from './agents/llm-client.js';
import { LlmStatusProbe, mockStatus, type LlmStatusSource } from './agents/llm-status.js';
import { MockLLMProvider } from './agents/mock-provider.js';
import { LlmBudget, singleRouting, type Routing } from './agents/budget.js';
import { loadProfile, profileRouting } from './agents/profiles.js';
import { LlmAgents } from './agents/orchestrator.js';
import { registerRoutes } from './api/routes.js';
import { Engine } from './engine/turn-machine.js';
import { worldData } from './engine/world-data.js';
import { JsonStore } from './store/json-store.js';

/** Stato dei modelli per il provider in uso: sonda HTTP per l'endpoint reale, sempre raggiungibile per il mock. */
export function llmStatusFor(provider: LlmProvider, o: { allowOffline?: boolean } = {}): LlmStatusSource {
  if (!(provider instanceof OpenAiCompatProvider)) return mockStatus();
  const offlineAllowed = o.allowOffline ?? config.allowOffline;
  return new LlmStatusProbe(provider.baseUrl, provider.apiKey, { enforced: !config.mock && !offlineAllowed, offlineAllowed });
}

/**
 * Gestore del budget dall'ambiente (LLM_BUDGET_CALLS, LLM_RPM, LLM_RPD, LLM_MAX_WAIT_MS): per un modello vero vale il limite di richieste al minuto
 * e al giorno, per i provider finti (mock, test) nessun limite.
 */
export function budgetFor(provider: LlmProvider, routing?: Routing): LlmBudget {
  if (routing) return LlmBudget.fromEnv(routing);
  const real = provider instanceof OpenAiCompatProvider;
  const num = (k: string, d: number) => (process.env[k]?.trim() ? Math.max(0, Number(process.env[k]) || 0) : d);
  return LlmBudget.fromEnv(singleRouting(provider, real ? { baseUrl: provider.baseUrl, rpm: num('LLM_RPM', 8), rpd: num('LLM_RPD', 1000) } : {}));
}

/**
 * Provider e instradamento dei modelli dall'ambiente: con LLM_PROFILE (o LLM_PROFILE_JSON) i modelli in ordine per ruolo del profilo, altrimenti
 * il provider unico di sempre (LLM_BASE_URL). Un provider passato a mano (test) o il mock (WARGAME_MOCK=1) ignorano i profili.
 */
export function llmFromEnv(o: { provider?: LlmProvider; mock?: boolean } = {}): { provider: LlmProvider; routing?: Routing } {
  if (o.provider) return { provider: o.provider };
  if (o.mock ?? config.mock) return { provider: new MockLLMProvider() };
  const profile = loadProfile();
  if (!profile) return { provider: new OpenAiCompatProvider() };
  const routing = profileRouting(profile);
  return { provider: routing.primary, routing };
}

export async function buildServer(opts: { dataDir?: string; provider?: LlmProvider; logger?: boolean; allowOffline?: boolean; llmStatus?: LlmStatusSource } = {}) {
  worldData(); // carica e valida i 197 Stati all'avvio: un file rotto ferma il server subito, non a metà partita
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: [config.corsOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/] });
  const { provider, routing } = llmFromEnv({ ...(opts.provider ? { provider: opts.provider } : {}) });
  const engine = new Engine(new JsonStore(opts.dataDir ?? config.dataDir), new LlmAgents(provider, budgetFor(provider, routing)));
  registerRoutes(app, engine, opts.llmStatus ?? llmStatusFor(provider, { allowOffline: opts.allowOffline }));
  return { app, engine };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = await buildServer({ logger: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`wargame-server su http://${config.host}:${config.port} (LLM: ${config.mock ? 'mock' : process.env.LLM_PROFILE ? `profilo ${process.env.LLM_PROFILE.startsWith('{') ? 'in .env' : process.env.LLM_PROFILE}` : process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1'}, fazioni: ${factionModeDefault()}${config.allowOffline ? ', turni anche senza modelli (WARGAME_ALLOW_OFFLINE)' : ''})`);
}
