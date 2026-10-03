import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatProvider } from '../src/agents/llm-client.js';
import { missingModels } from '../src/agents/llm-status.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { buildServer } from '../src/index.js';
import { tmp } from './helpers.js';

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>) => {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

describe('stato dei modelli: budget e contatori', () => {
  it('GET /llm/status riporta profilo, tetto per turno e, con la campagna, i contatori per turno e per giorno', async () => withEnv({ LLM_BUDGET_CALLS: '6' }, async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const none = (await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json();
    expect(none.budget).toMatchObject({ profile: 'predefinito', callsPerTurn: 6, cache: true, campaign: null });
    const c = (await app.inject({ method: 'POST', url: '/api/wg/campaigns', payload: { name: 'stato', seed: 'stato-budget' } })).json();
    await app.inject({ method: 'POST', url: `/api/wg/campaigns/${c.id}/advance` });
    const st = (await app.inject({ method: 'GET', url: `/api/wg/llm/status?campaignId=${c.id}` })).json();
    expect(st.budget.callsPerTurn).toBe(6);
    expect(st.budget.campaign.callsPerTurn).toBe(6);
    expect(st.budget.campaign.turn).toMatchObject({ turn: 2 });
    expect(st.budget.campaign.turn.admitted).toBeLessThanOrEqual(6);
    expect(st.budget.campaign.turn.remaining).toBe(6 - st.budget.campaign.turn.admitted);
    expect(st.budget.campaign.today.calls).toBeGreaterThan(0);
    expect(st.budget.campaign.today.tokensIn).toBeGreaterThan(0);
    expect(Object.keys(st.budget.campaign.turns).sort()).toEqual(['1', '2']);
    // ogni turno rispetta il tetto e il resto è stato saltato, non perso
    for (const t of Object.values(st.budget.campaign.turns) as { admitted: number; calls: number }[]) { expect(t.admitted).toBeLessThanOrEqual(6); expect(t.calls).toBeLessThanOrEqual(6); }
    expect(Object.values(st.budget.campaign.turns).reduce((a: number, t) => a + (t as { skipped: number }).skipped, 0)).toBeGreaterThan(0);
    expect(st.models.strategist).toBeDefined();
    expect(st.models.chancery).toBeDefined();
  }), 60_000);

  it('con LLM_BUDGET_CALLS=0 il tetto è 0 e nessuna chiamata parte', async () => withEnv({ LLM_BUDGET_CALLS: '0' }, async () => {
    const mock = new MockLLMProvider();
    const { app } = await buildServer({ dataDir: tmp(), provider: mock });
    const c = (await app.inject({ method: 'POST', url: '/api/wg/campaigns', payload: { name: 'zero', seed: 'zero' } })).json();
    await app.inject({ method: 'POST', url: `/api/wg/campaigns/${c.id}/advance` });
    expect(mock.calls).toBe(0);
    const st = (await app.inject({ method: 'GET', url: `/api/wg/llm/status?campaignId=${c.id}` })).json();
    expect(st.budget.campaign.today).toMatchObject({ calls: 0, tokensIn: 0 });
    expect(st.budget.campaign.turn.skipped).toBeGreaterThan(0);
  }), 60_000);

  it('il nome del modello di Google («models/gemini-2.5-flash») conta come presente', () => {
    expect(missingModels({ a: 'gemini-2.5-flash', b: 'gemini-2.5-flash-lite' }, ['models/gemini-2.5-flash'])).toEqual(['gemini-2.5-flash-lite']);
    expect(missingModels({ a: 'qwen3.5:4b' }, ['qwen3.5:4b:latest'])).toEqual([]);
  });
});

/** Un server che elenca i modelli come Google: la rotta mostra il limite per modello dell'endpoint. */
describe('rotta /llm/status con un endpoint vero', () => {
  let fake: Server; let url = '';
  beforeAll(async () => {
    fake = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'models/gemini-2.5-flash' }] })); });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise((r) => fake.close(r)));

  it('LLM_RPM e LLM_RPD diventano i limiti dell\'endpoint; i modelli di Google risultano presenti', async () => withEnv({ LLM_RPM: '12', LLM_RPD: '900', LLM_MODEL: 'gemini-2.5-flash' }, async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new OpenAiCompatProvider(url) });
    const st = (await app.inject({ method: 'GET', url: '/api/wg/llm/status' })).json();
    expect(st.missing).toEqual([]);
    expect(st.budget.endpoints[0]).toMatchObject({ key: url, rpm: 12, rpd: 900 });
  }));
});
