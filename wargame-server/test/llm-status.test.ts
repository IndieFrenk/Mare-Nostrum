import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatProvider } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { buildServer } from '../src/index.js';
import { makeEngine, tmp } from './helpers.js';

/** Server finto «Ollama»: GET /v1/models con due modelli; conta le richieste per verificare la cache. */
let fake: Server; let fakeUrl = ''; let hits = 0;
/** porta chiusa: nessuno risponde (PC spento) */
let deadUrl = '';
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  fake = createServer((req, res) => {
    hits++;
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.5:4b' }, { id: 'qwen3.5:9b' }] })); return; }
    res.writeHead(404); res.end();
  });
  fakeUrl = `http://127.0.0.1:${await listen(fake)}/v1`;
  const dead = createServer();
  deadUrl = `http://127.0.0.1:${await listen(dead)}/v1`;
  await new Promise((r) => dead.close(r));
});
afterAll(() => new Promise((r) => fake.close(r)));

/** modelli configurati come sul PC del giocatore, più uno che non c'è */
const withModels = async <T>(fn: () => Promise<T>) => {
  const keep = { ...process.env };
  Object.assign(process.env, { LLM_MODEL: 'qwen3.5:4b', LLM_MODEL_GM_NARRATOR: 'qwen3.5:9b', LLM_MODEL_ORDER_PARSER: 'qwen3.5:9b', LLM_MODEL_DIPLOMAT: 'gemma3:27b' });
  try { return await fn(); } finally { for (const k of ['LLM_MODEL', 'LLM_MODEL_GM_NARRATOR', 'LLM_MODEL_ORDER_PARSER', 'LLM_MODEL_DIPLOMAT']) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
};

describe('stato dei modelli', () => {
  it('server raggiungibile: modelli per ruolo, mancanti, latenza e cache di 30 s', async () => withModels(async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new OpenAiCompatProvider(fakeUrl) });
    const before = hits;
    const st = (await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json();
    expect(st).toMatchObject({ reachable: true, mode: 'llm', baseUrl: fakeUrl, missing: ['gemma3:27b'], listed: ['qwen3.5:4b', 'qwen3.5:9b'], cached: false, enforced: true });
    // modalità predefinita «rules»: solo i ruoli che usano ancora l'LLM (le fazioni decidono con le regole del motore)
    expect(st.factionMode).toBe('rules');
    expect(st.models).toEqual({ gm_narrator: 'qwen3.5:9b', intel_analyst: 'qwen3.5:4b', order_parser: 'qwen3.5:9b', repair: 'qwen3.5:4b', diplomat: 'gemma3:27b' });
    expect(typeof st.latencyMs).toBe('number');
    const again = (await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json();
    expect(again.cached).toBe(true);
    expect(hits - before).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/wg/llm/status?fresh=1' })).json().cached).toBe(false);
    expect(hits - before).toBe(2);
  }));

  it('modalità llm: tutti i ruoli, anche decisioni e riflessione delle fazioni', async () => withModels(async () => {
    process.env.WARGAME_FACTION_MODE = 'llm';
    try {
      const { app } = await buildServer({ dataDir: tmp(), provider: new OpenAiCompatProvider(fakeUrl) });
      const st = (await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json();
      expect(st.factionMode).toBe('llm');
      expect(st.models).toMatchObject({ faction_major: 'qwen3.5:4b', faction_minor: 'qwen3.5:4b', reflection: 'qwen3.5:4b', gm_narrator: 'qwen3.5:9b', order_parser: 'qwen3.5:9b', diplomat: 'gemma3:27b' });
    } finally { delete process.env.WARGAME_FACTION_MODE; }
  }));

  it('server irraggiungibile: reachable false, ▶ e creazione rifiutati con 503 LLM_UNREACHABLE', async () => {
    const dir = tmp();
    // la campagna esiste già (creata col mock), poi il PC con Ollama si spegne
    const c = await makeEngine(new MockLLMProvider(), dir).createCampaign({ scenarioId: 'med-2026', name: 'offline', seed: 'offline' });
    const { app } = await buildServer({ dataDir: dir, provider: new OpenAiCompatProvider(deadUrl) });
    const st = (await app.inject({ method: 'GET', url: `/api/wg/llm/status?campaignId=${c.id}` })).json();
    expect(st).toMatchObject({ reachable: false, baseUrl: deadUrl, latencyMs: null, enforced: true, offlineAllowed: false });
    expect(st.error).toBeTruthy();
    const adv = await app.inject({ method: 'POST', url: `/api/wg/campaigns/${c.id}/advance` });
    expect(adv.statusCode).toBe(503);
    expect(adv.json().error.code).toBe('LLM_UNREACHABLE');
    expect(adv.json().error.message).toContain('I modelli non rispondono: accendi il PC con Ollama');
    const create = await app.inject({ method: 'POST', url: '/api/wg/campaigns', payload: { name: 'x' } });
    expect(create.statusCode).toBe(503);
    const parse = await app.inject({ method: 'POST', url: `/api/wg/campaigns/${c.id}/orders/parse`, payload: { text: 'Pattuglia lo Ionio' } });
    expect(parse.statusCode).toBe(503);
    // il turno non è partito
    expect((await app.inject({ method: 'GET', url: `/api/wg/campaigns/${c.id}` })).json().currentTurn).toBe(1);
  });

  it('WARGAME_ALLOW_OFFLINE: lo stato resta rosso ma ▶ non viene bloccato', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new OpenAiCompatProvider(deadUrl), allowOffline: true });
    expect((await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json()).toMatchObject({ reachable: false, enforced: false, offlineAllowed: true });
  });

  it('mock: sempre raggiungibile, nessuna rete', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    expect((await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json()).toMatchObject({ reachable: true, mode: 'mock', enforced: false, missing: [] });
  });
});
