import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmBudget, ManualClock, RateLimiter, SlidingWindow, singleRouting, type Endpoint, type Routing } from '../src/agents/budget.js';
import { LlmSkipped, OpenAiCompatProvider, RateLimitError, retryAfterMs, type LlmProvider, type LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { callStructured } from '../src/agents/repair.js';
import type { LlmCall } from '../src/schemas/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { Engine } from '../src/engine/turn-machine.js';
import { z } from 'zod';
import { tmp } from './helpers.js';

const req = (user: string, role: LlmRequest['role'] = 'gm_narrator'): LlmRequest => ({ role, model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000, system: 's', user, schemaName: 'X', jsonSchema: {}, meta: {} });
const campaign = { id: 'c1', config: { factionMode: 'rules' as const } };

/** Provider finto programmabile: ogni chiamata esegue il comportamento dato (risposta, 429 o errore). */
function scripted(name: string, behave: (n: number, r: LlmRequest) => 'ok' | 'ratelimit' | { retryAfterMs: number } | Error = () => 'ok') {
  const calls: LlmRequest[] = [];
  const p: LlmProvider & { calls: LlmRequest[] } = {
    name, calls,
    async complete(r) {
      calls.push(r);
      const b = behave(calls.length, r);
      if (b === 'ok') return { text: '{"ok":true}', usage: { promptTokens: 4, completionTokens: 2 }, latencyMs: 1, model: r.model };
      if (b instanceof Error) throw b;
      throw new RateLimitError('HTTP 429', b === 'ratelimit' ? null : b.retryAfterMs);
    },
  };
  return p;
}
/** Profilo a modelli in ordine (uguale per tutti i ruoli), come quelli di `llm-profiles/`. */
const chain = (...eps: { provider: LlmProvider; model: string; rpm?: number; rpd?: number }[]): Routing => {
  const list: Endpoint[] = eps.map((e) => ({ key: e.provider.name, label: e.model, provider: e.provider, model: e.model, rpm: e.rpm ?? 0, rpd: e.rpd ?? 0 }));
  return { name: 'prova', baseUrl: 'http://prova', endpointsFor: () => list, all: () => list };
};

describe('finestra scorrevole', () => {
  it('al massimo `limit` richieste negli ultimi 60 s, poi dice quanto aspettare', () => {
    const w = new SlidingWindow(3, 60_000);
    for (const t of [0, 10_000, 20_000]) { expect(w.waitMs(t)).toBe(0); w.take(t); }
    expect(w.waitMs(30_000)).toBe(30_000); // la più vecchia (t=0) esce alla 60 s
    expect(w.waitMs(59_999)).toBe(1);
    expect(w.waitMs(60_000)).toBe(0);
    w.take(60_000);
    expect(w.waitMs(60_001)).toBe(9_999); // ora la più vecchia è t=10 s
    expect(w.count(70_000)).toBe(2); // 20 s e 60 s
  });

  it('limite 0 = nessun limite', () => {
    const w = new SlidingWindow(0, 60_000);
    for (let i = 0; i < 100; i++) w.take(i);
    expect(w.waitMs(100)).toBe(0);
    const l = new RateLimiter(0, 0);
    expect(l.check(0)).toEqual({ wait: 0, daily: false });
  });

  it('il limite del giorno ha la precedenza e si segnala come tale', () => {
    const l = new RateLimiter(10, 2);
    l.take(0); l.take(1000);
    expect(l.check(2000)).toEqual({ wait: 86_400_000 - 2000, daily: true });
  });
});

describe('limite di richieste al minuto (orologio finto)', () => {
  it('la terza richiesta con 2 al minuto aspetta che si liberi un posto, senza perdere il turno', async () => {
    const clock = new ManualClock(0);
    const p = scripted('a');
    const b = new LlmBudget(chain({ provider: p, model: 'm1', rpm: 2 }), { callsPerTurn: 10, cache: false, clock, maxWaitMs: 120_000 });
    await b.run(campaign, 1, 2, req('1')); await b.run(campaign, 1, 2, req('2'));
    expect(clock.t).toBe(0);
    await b.run(campaign, 1, 2, req('3'));
    expect(p.calls).toHaveLength(3);
    expect(clock.t).toBeGreaterThanOrEqual(60_000); // ha aspettato il primo posto utile
    const st = await b.status(campaign, 1);
    expect(st.endpoints[0]).toMatchObject({ rpm: 2, inLastMinute: 1 }); // le due richieste a t=0 sono uscite dalla finestra, resta la terza
  });

  it('se il posto è troppo lontano (oltre maxWaitMs) la richiesta non parte e il ruolo usa il testo deterministico', async () => {
    const clock = new ManualClock(0);
    const p = scripted('a');
    const b = new LlmBudget(chain({ provider: p, model: 'm1', rpm: 1 }), { callsPerTurn: 10, cache: false, clock, maxWaitMs: 5_000 });
    await b.run(campaign, 1, 2, req('1'));
    await expect(b.run(campaign, 1, 2, req('2'))).rejects.toMatchObject({ name: 'LlmSkipped', reason: 'rate' });
    expect(clock.t).toBe(0); // nessuna attesa inutile
    expect(p.calls).toHaveLength(1);
    // il posto nel budget del turno non è stato usato
    expect((await b.status(campaign, 1)).campaign!.turn).toMatchObject({ admitted: 1, skipped: 1 });
  });

  it('con due modelli, se il primo è al limite si passa subito al secondo senza aspettare', async () => {
    const clock = new ManualClock(0);
    const a = scripted('a'); const z2 = scripted('b');
    const b = new LlmBudget(chain({ provider: a, model: 'flash', rpm: 1 }, { provider: z2, model: 'lite', rpm: 5 }), { callsPerTurn: 10, cache: false, clock });
    await b.run(campaign, 1, 2, req('1')); await b.run(campaign, 1, 2, req('2'));
    expect(a.calls).toHaveLength(1); expect(z2.calls).toHaveLength(1);
    expect(clock.t).toBe(0);
    expect((await b.status(campaign, 1)).campaign!.turn).toMatchObject({ fallbacks: 1, rate429: 0 });
  });

  it('il limite del giorno non si aspetta: LlmSkipped(daily)', async () => {
    const clock = new ManualClock(0);
    const p = scripted('a');
    const b = new LlmBudget(chain({ provider: p, model: 'm1', rpd: 2 }), { callsPerTurn: 10, cache: false, clock, maxWaitMs: 10 * 3600_000 });
    await b.run(campaign, 1, 2, req('1')); await b.run(campaign, 1, 2, req('2'));
    await expect(b.run(campaign, 1, 2, req('3'))).rejects.toMatchObject({ reason: 'daily' });
    expect(clock.t).toBe(0);
    clock.advance(86_400_000 + 1);
    await b.run(campaign, 2, 2, req('4')); // il giorno dopo si riparte
    expect(p.calls).toHaveLength(3);
  });

  it('il limite vale per modello: due modelli dello stesso endpoint hanno finestre separate', async () => {
    const clock = new ManualClock(0);
    const p = scripted('a');
    const b = new LlmBudget(singleRouting(p, { rpm: 1 }), { callsPerTurn: 10, cache: false, clock, maxWaitMs: 0 });
    await b.run(campaign, 1, 2, { ...req('1'), model: 'x' });
    await b.run(campaign, 1, 2, { ...req('2'), model: 'y' });
    await expect(b.run(campaign, 1, 2, { ...req('3'), model: 'x' })).rejects.toBeInstanceOf(LlmSkipped);
    expect(p.calls.map((c) => c.model)).toEqual(['x', 'y']);
  });
});

describe('429: ripiego sul modello successivo', () => {
  it('su 429 la richiesta passa al modello successivo, il primo resta in pausa per il Retry-After e poi torna', async () => {
    const clock = new ManualClock(1_000_000);
    const first = scripted('flash', (n) => (n === 1 ? { retryAfterMs: 5_000 } : 'ok'));
    const second = scripted('lite');
    const b = new LlmBudget(chain({ provider: first, model: 'flash' }, { provider: second, model: 'lite' }), { callsPerTurn: 10, cache: false, clock });
    const r = await b.run(campaign, 1, 2, req('1'));
    expect(r.model).toBe('lite');
    expect(first.calls).toHaveLength(1);
    // dentro i 5 s il primo non si riprova
    await b.run(campaign, 1, 2, req('2'));
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(2);
    clock.advance(5_001);
    expect((await b.run(campaign, 1, 2, req('3'))).model).toBe('flash');
    const t = (await b.status(campaign, 1)).campaign!.turn!;
    expect(t).toMatchObject({ rate429: 1, fallbacks: 2, admitted: 3 });
    expect((await b.status(campaign, 1)).endpoints[0]!.coolingMs).toBe(0);
  });

  it('il modello cambia nella richiesta (profilo) e il budget conta una richiesta sola', async () => {
    const first = scripted('flash', () => 'ratelimit');
    const second = scripted('lite');
    const b = new LlmBudget(chain({ provider: first, model: 'gemini-flash' }, { provider: second, model: 'gemini-lite' }), { callsPerTurn: 1, cache: false, clock: new ManualClock(0) });
    await b.run(campaign, 1, 2, req('1'));
    expect(second.calls[0]!.model).toBe('gemini-lite');
    expect((await b.status(campaign, 1)).campaign!.turn).toMatchObject({ admitted: 1, calls: 2, rate429: 1, fallbacks: 1 });
  });

  it('un errore di rete sul primo modello passa al secondo; se falliscono tutti l\'errore sale', async () => {
    const down = scripted('a', () => new Error('ECONNREFUSED'));
    const ok = scripted('b');
    const b = new LlmBudget(chain({ provider: down, model: 'x' }, { provider: ok, model: 'y' }), { callsPerTurn: 10, cache: false, clock: new ManualClock(0) });
    expect((await b.run(campaign, 1, 2, req('1'))).model).toBe('y');
    const dead = new LlmBudget(chain({ provider: down, model: 'x' }), { callsPerTurn: 10, cache: false, clock: new ManualClock(0) });
    await expect(dead.run(campaign, 1, 2, req('1'))).rejects.toThrow('ECONNREFUSED');
  });

  it('tutti i modelli in 429: LlmSkipped(429) subito, senza attese, e callStructured passa al testo deterministico', async () => {
    const clock = new ManualClock(0);
    const a = scripted('a', () => ({ retryAfterMs: 20_000 })); const c = scripted('b', () => 'ratelimit');
    const b = new LlmBudget(chain({ provider: a, model: 'x' }, { provider: c, model: 'y' }), { callsPerTurn: 10, cache: false, clock });
    const log: LlmCall[] = [];
    const r = await callStructured(b.view(campaign, 1, 2), log, { turn: 1 }, req('1'), z.object({ ok: z.boolean() }));
    expect(r).toMatchObject({ value: null, skipped: '429' });
    expect(log).toHaveLength(0);
    expect(clock.t).toBe(0);
    expect((await b.status(campaign, 1)).campaign!.turn).toMatchObject({ rate429: 2, skipped: 1, admitted: 1 });
    // ancora in pausa: la richiesta dopo non parte nemmeno
    await expect(b.run(campaign, 1, 2, req('2'))).rejects.toMatchObject({ reason: '429' });
    expect(a.calls).toHaveLength(1);
  });

  it('con tutti i modelli in 429 il turno si completa con i testi deterministici', async () => {
    const dead = scripted('tutti-429', () => 'ratelimit');
    const store = new JsonStore(tmp());
    const e = new Engine(store, new LlmAgents(dead, new LlmBudget(singleRouting(dead), { callsPerTurn: 10, cooldownMs: 3_600_000 })));
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: '429', seed: '429', config: { factionMode: 'rules' } });
    c = await e.advance(c.id);
    c = await e.advance(c.id);
    expect(c.currentTurn).toBe(3);
    expect((await store.getNarrative(c.id, 2))!.briefing.sections.length).toBeGreaterThan(0);
    const letters = (await store.getDecision(c.id, 2, 'USA'))!.letters;
    expect(letters.every((l) => l.source === 'template')).toBe(true);
    // la pausa dopo il primo 429 evita di martellare il provider: solo le due richieste partite insieme (briefing e intel) prima del primo 429
    expect(dead.calls.length).toBeLessThanOrEqual(2);
    const usage = (await store.getLlmUsage(c.id))!;
    expect(Object.values(usage.turns).reduce((a, u) => a + u.rate429, 0)).toBe(dead.calls.length);
    expect(Object.values(usage.turns).reduce((a, u) => a + u.skipped, 0)).toBeGreaterThan(3);
  }, 120_000);
});

describe('HTTP 429 e Retry-After', () => {
  it('retryAfterMs legge secondi, data HTTP e il retryDelay di Google', () => {
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs(new Date(Date.now() + 12_000).toUTCString())!).toBeGreaterThan(9000);
    expect(retryAfterMs(null, '{"error":{"details":[{"retryDelay":"34s"}]}}')).toBe(34_000);
    expect(retryAfterMs(null, 'niente')).toBeNull();
  });

  let first: Server; let second: Server; let base1 = ''; let base2 = '';
  const seen = { first: 0, second: 0 };
  const mock = new MockLLMProvider();
  beforeAll(async () => {
    const listen = async (handler: (b: Record<string, unknown>, res: import('node:http').ServerResponse) => void) => {
      const s = createServer((rq, res) => { let body = ''; rq.on('data', (c) => (body += c)); rq.on('end', () => handler(JSON.parse(body || '{}'), res)); }).listen(0);
      await new Promise((r) => s.once('listening', r));
      return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1` };
    };
    ({ s: first, base: base1 } = await listen((_b, res) => { seen.first++; res.statusCode = 429; res.setHeader('retry-after', '7'); res.end('{"error":"quota"}'); }));
    ({ s: second, base: base2 } = await listen((b, res) => { seen.second++; res.end(JSON.stringify({ model: b.model, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })); }));
    void mock;
  });
  afterAll(() => { first.close(); second.close(); });

  it('il client senza tentativi in più (retry429: 0) alza subito RateLimitError con il Retry-After', async () => {
    const p = new OpenAiCompatProvider(base1, undefined, 'json_object', { retry429: 0 });
    const err = await p.complete(req('x')).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7000);
    expect(seen.first).toBe(1);
  });

  it('end-to-end: il primo endpoint risponde 429, la richiesta riesce sul secondo e il primo va in pausa 7 s', async () => {
    seen.first = 0; seen.second = 0;
    const clock = new ManualClock(0);
    const b = new LlmBudget(chain(
      { provider: Object.assign(new OpenAiCompatProvider(base1, undefined, 'json_object', { retry429: 0 }), { name: 'e1' }), model: 'flash' },
      { provider: Object.assign(new OpenAiCompatProvider(base2, undefined, 'json_object', { retry429: 0 }), { name: 'e2' }), model: 'flash-lite' },
    ), { callsPerTurn: 10, cache: false, clock });
    const r = await b.run(campaign, 1, 2, req('uno'));
    expect(r).toMatchObject({ model: 'flash-lite', text: '{"ok":true}' });
    await b.run(campaign, 1, 2, req('due'));
    expect(seen).toEqual({ first: 1, second: 2 });
    clock.advance(7_001);
    await b.run(campaign, 1, 2, req('tre'));
    expect(seen.first).toBe(2);
  });
});
