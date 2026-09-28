import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config } from './config.js';
import { OpenAiCompatProvider, type LlmProvider } from './agents/llm-client.js';
import { MockLLMProvider } from './agents/mock-provider.js';
import { LlmAgents } from './agents/orchestrator.js';
import { registerRoutes } from './api/routes.js';
import { Engine } from './engine/turn-machine.js';
import { JsonStore } from './store/json-store.js';

export async function buildServer(opts: { dataDir?: string; provider?: LlmProvider; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: [config.corsOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/] });
  const provider = opts.provider ?? (config.mock ? new MockLLMProvider() : new OpenAiCompatProvider());
  const engine = new Engine(new JsonStore(opts.dataDir ?? config.dataDir), new LlmAgents(provider));
  registerRoutes(app, engine);
  return { app, engine };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = await buildServer({ logger: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`wargame-server su http://${config.host}:${config.port} (LLM: ${config.mock ? 'mock' : process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1'})`);
}
