import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config, factionModeDefault } from './config.js';
import { OpenAiCompatProvider, type LlmProvider } from './agents/llm-client.js';
import { LlmStatusProbe, mockStatus, type LlmStatusSource } from './agents/llm-status.js';
import { MockLLMProvider } from './agents/mock-provider.js';
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

export async function buildServer(opts: { dataDir?: string; provider?: LlmProvider; logger?: boolean; allowOffline?: boolean; llmStatus?: LlmStatusSource } = {}) {
  worldData(); // carica e valida i 197 Stati all'avvio: un file rotto ferma il server subito, non a metà partita
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: [config.corsOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/] });
  const provider = opts.provider ?? (config.mock ? new MockLLMProvider() : new OpenAiCompatProvider());
  const engine = new Engine(new JsonStore(opts.dataDir ?? config.dataDir), new LlmAgents(provider));
  registerRoutes(app, engine, opts.llmStatus ?? llmStatusFor(provider, { allowOffline: opts.allowOffline }));
  return { app, engine };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = await buildServer({ logger: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`wargame-server su http://${config.host}:${config.port} (LLM: ${config.mock ? 'mock' : process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1'}, fazioni: ${factionModeDefault()}${config.allowOffline ? ', turni anche senza modelli (WARGAME_ALLOW_OFFLINE)' : ''})`);
}
