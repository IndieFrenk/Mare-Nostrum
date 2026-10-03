import { describe, expect, it } from 'vitest';
import { LlmBudget, allowCall, emptyUsage, singleRouting, type UsageStore } from '../src/agents/budget.js';
import { LlmSkipped, type LlmProvider, type LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { callStructured } from '../src/agents/repair.js';
import type { LlmCall, LlmUsage } from '../src/schemas/index.js';
import type { LlmCacheRow } from '../src/store/json-store.js';
import { JsonStore } from '../src/store/json-store.js';
import { Engine } from '../src/engine/turn-machine.js';
import { z } from 'zod';
import { tmp } from './helpers.js';

/** Provider finto che conta le chiamate e risponde con un JSON fisso. */
const counting = (payload: unknown = { ok: true }) => {
  const calls: LlmRequest[] = [];
  const p: LlmProvider & { calls: LlmRequest[] } = { name: 'finto', calls, async complete(req) { calls.push(req); return { text: JSON.stringify(payload), usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 1, model: req.model }; } };
  return p;
};
const req = (user: string, role: LlmRequest['role'] = 'gm_narrator'): LlmRequest => ({ role, model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000, system: 's', user, schemaName: 'X', jsonSchema: {}, meta: {} });
const campaign = (mode: 'rules' | 'llm' = 'rules') => ({ id: 'c1', config: { factionMode: mode } });

/** Registro in memoria con lo stesso contratto dello store (per provare il riavvio senza disco). */
function memStore(): UsageStore & { usage: LlmUsage | null; rows: LlmCacheRow[] } {
  const s = { usage: null as LlmUsage | null, rows: [] as LlmCacheRow[],
    async getLlmUsage() { return s.usage ? structuredClone(s.usage) : null; }, async saveLlmUsage(_: string, u: LlmUsage) { s.usage = structuredClone(u); },
    async getLlmCache() { return [...s.rows]; }, async appendLlmCache(_: string, r: LlmCacheRow[]) { s.rows.push(...r); } };
  return s;
}

describe('budget: calcolo delle riserve', () => {
  it('una priorità lascia il posto alle più alte che il motore ha dichiarato', () => {
    expect(allowCall(0, 3, [0, 0, 0, 0, 0, 0], 5)).toBe(true);
    expect(allowCall(2, 3, [0, 0, 0, 0, 0, 0], 5)).toBe(true);
    expect(allowCall(3, 3, [0, 0, 0, 0, 0, 0], 0)).toBe(false);
    // due chiamate P1 ancora attese: una P5 con 1 già fatta ha 1+1+2 = 4 > 3
    expect(allowCall(1, 3, [0, 2, 0, 0, 0, 0], 5)).toBe(false);
    // ma una P1 passa (le riserve della stessa priorità non contano) e una P0 anche
    expect(allowCall(1, 3, [0, 2, 0, 0, 0, 0], 1)).toBe(true);
    expect(allowCall(1, 3, [0, 2, 0, 0, 0, 0], 0)).toBe(true);
  });
});

describe('budget per turno', () => {
  it('oltre il tetto le chiamate non partono: LlmSkipped(budget), e il turno dopo riparte da zero', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 3, cache: false });
    const c = campaign();
    const ok: boolean[] = [];
    for (let i = 0; i < 5; i++) ok.push(await b.run(c, 1, 2, req(`u${i}`)).then(() => true, (e) => { expect(e).toBeInstanceOf(LlmSkipped); expect((e as LlmSkipped).reason).toBe('budget'); return false; }));
    expect(ok).toEqual([true, true, true, false, false]);
    expect(p.calls).toHaveLength(3);
    const st = await b.status(c, 1);
    expect(st.callsPerTurn).toBe(3);
    expect(st.campaign!.turn).toMatchObject({ turn: 1, admitted: 3, calls: 3, skipped: 2, remaining: 0, tokensIn: 30, tokensOut: 15, skippedByPriority: { '2': 2 }, byRole: { gm_narrator: 3 } });
    await b.run(c, 2, 2, req('turno 2'));
    expect(p.calls).toHaveLength(4);
    expect((await b.status(c, 2)).campaign!.turn).toMatchObject({ turn: 2, admitted: 1, remaining: 2 });
  });

  it('con 0 chiamate non parte niente: solo testi deterministici', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 0 });
    await expect(b.run(campaign(), 1, 0, req('x'))).rejects.toThrow(/LLM_BUDGET_CALLS=0/);
    expect(p.calls).toHaveLength(0);
  });

  it('senza LLM_BUDGET_CALLS: 10 chiamate nelle campagne a regole, nessun tetto in modalità llm', () => {
    const b = new LlmBudget(singleRouting(counting()));
    expect(b.limitFor(campaign('rules'))).toBe(10);
    expect(b.limitFor(campaign('llm'))).toBe(Infinity);
    expect(new LlmBudget(singleRouting(counting()), { callsPerTurn: 4 }).limitFor(campaign('llm'))).toBe(4);
    expect(LlmBudget.callsFromEnv({ LLM_BUDGET_CALLS: '0' })).toBe(0);
    expect(LlmBudget.callsFromEnv({ LLM_BUDGET_CALLS: '25' })).toBe(25);
    expect(LlmBudget.callsFromEnv({ LLM_BUDGET_CALLS: 'unlimited' })).toBe(Infinity);
    expect(LlmBudget.callsFromEnv({})).toBeUndefined();
  });

  it('un riavvio a metà turno riparte dai contatori del registro: il budget non si spende due volte', async () => {
    const store = memStore();
    const p = counting();
    const a = new LlmBudget(singleRouting(p), { callsPerTurn: 2, cache: false }); a.attach(store);
    await a.run(campaign(), 4, 1, req('a')); await a.run(campaign(), 4, 1, req('b'));
    await a.settle();
    expect(store.usage!.turns['4']!.admitted).toBe(2);
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 2, cache: false }); b.attach(store);
    await expect(b.run(campaign(), 4, 0, req('c'))).rejects.toBeInstanceOf(LlmSkipped);
    await b.run(campaign(), 5, 0, req('c'));
  });
});

describe('coda a priorità', () => {
  it('quando non c\'è posto per tutti cadono prima le priorità basse (a parità, le ultime arrivate)', async () => {
    const b = new LlmBudget(singleRouting(counting()), { callsPerTurn: 3, cache: false });
    const c = campaign();
    const ok = await b.admit(c, 1, [5, 1, 5, 3, 0, 2].map((priority) => ({ priority: priority as 0 | 1 | 2 | 3 | 4 | 5 })));
    // P0, P1 e P2 entrano; cadono P3, P5, P5
    expect(ok).toEqual([false, true, false, false, true, true]);
    const t = (await b.status(c, 1)).campaign!.turn!;
    expect(t.skipped).toBe(3);
    expect(t.skippedByPriority).toEqual({ '5': 2, '3': 1 });
  });

  it('le richieste ammesse tengono il posto: una P5 che arriva prima di una P1 dello stesso gruppo non la scavalca', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 2, cache: false });
    const c = campaign();
    const ok = await b.admit(c, 1, [{ priority: 5 }, { priority: 1 }, { priority: 1 }]);
    expect(ok).toEqual([false, true, true]);
    // la P5 non ammessa non chiama; le due P1 passano
    await b.run(c, 1, 1, req('x')); await b.run(c, 1, 1, req('y'));
    expect(p.calls).toHaveLength(2);
  });

  it('le chiamate dichiarate dal motore (expect) riservano il loro posto: la direttiva P3 lascia le risposte P1', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 2, cache: false });
    const c = campaign();
    await b.expect(c, 1, { 1: 1 });
    await b.run(c, 1, 3, req('direttiva')); // 0 + 1 + 1 = 2 ≤ 2
    await expect(b.run(c, 1, 3, req('un\'altra direttiva'))).rejects.toBeInstanceOf(LlmSkipped); // 1 + 1 + 1 = 3 > 2
    await b.run(c, 1, 1, req('risposta al giocatore'));
    expect(p.calls.map((r) => r.user)).toEqual(['direttiva', 'risposta al giocatore']);
  });

  it('la riserva del debriefing e delle notizie: le lettere tra IA non le mangiano', async () => {
    const b = new LlmBudget(singleRouting(counting()), { callsPerTurn: 4, cache: false });
    const c = campaign();
    await b.run(c, 1, 0, req('briefing'));
    await b.expect(c, 1, { 0: 1, 2: 1 });
    // restano 3 posti, 2 riservati: una lettera tra IA sì, la seconda no; il debriefing (P0) e le notizie (P2) passano
    await b.run(c, 1, 5, req('lettera 1'));
    await expect(b.run(c, 1, 5, req('lettera 2'))).rejects.toBeInstanceOf(LlmSkipped);
    await b.run(c, 1, 0, req('debriefing'));
    await b.run(c, 1, 2, req('notizie'));
    expect((await b.status(c, 1)).campaign!.turn!.admitted).toBe(4);
  });
});

describe('cache per promptHash', () => {
  it('la stessa richiesta riceve la stessa risposta senza chiamare il modello, anche dopo un riavvio', async () => {
    const store = memStore();
    const p = counting({ n: 1 });
    const a = new LlmBudget(singleRouting(p), { callsPerTurn: 10 }); a.attach(store);
    const r1 = await a.run(campaign(), 1, 2, req('uguale'));
    const r2 = await a.run(campaign(), 1, 2, req('uguale'));
    expect(p.calls).toHaveLength(1);
    expect(r2).toMatchObject({ cached: true, text: r1.text, latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0 } });
    await a.run(campaign(), 1, 2, req('diversa'));
    expect(p.calls).toHaveLength(2);
    await a.settle();
    // riavvio: un gestore nuovo sullo stesso registro
    const p2 = counting({ n: 2 });
    const b = new LlmBudget(singleRouting(p2), { callsPerTurn: 10 }); b.attach(store);
    const r3 = await b.run(campaign(), 2, 2, req('uguale'));
    expect(p2.calls).toHaveLength(0);
    expect(r3.text).toBe(r1.text);
    expect((await b.status(campaign(), 2)).campaign!.turn).toMatchObject({ cacheHits: 1, admitted: 0, calls: 0 });
  });

  it('la cache non costa budget e risponde anche a budget finito', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 1 });
    await b.run(campaign(), 1, 2, req('a'));
    await expect(b.run(campaign(), 1, 2, req('b'))).rejects.toBeInstanceOf(LlmSkipped);
    expect((await b.run(campaign(), 1, 2, req('a'))).cached).toBe(true);
    // e nel gruppo `admit` una richiesta già in cache è gratis
    expect(await b.admit(campaign(), 1, [{ priority: 5, hash: (await import('../src/agents/repair.js')).promptHash(req('a')) }, { priority: 5 }])).toEqual([true, false]);
  });

  it('una risposta scartata dal validatore esce dalla cache (anche dopo un riavvio)', async () => {
    const store = memStore();
    const p = counting({ sbagliato: true });
    const a = new LlmBudget(singleRouting(p), { callsPerTurn: 10 }); a.attach(store);
    const log: LlmCall[] = [];
    const schema = z.object({ ok: z.boolean() });
    const r = await callStructured(a.view(campaign(), 1, 2), log, { turn: 1 }, req('richiesta'), schema, () => [], 0);
    expect(r.value).toBeNull();
    await a.settle();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 10 }); b.attach(store);
    await b.run(campaign(), 1, 2, req('richiesta'));
    expect(p.calls).toHaveLength(2); // richiesta di nuovo al modello, non dalla cache
  });

  it('senza cache (predefinito di LlmAgents) ogni richiesta va al modello', async () => {
    const p = counting();
    const b = LlmBudget.unlimited(p);
    await b.run(campaign(), 1, 2, req('uguale')); await b.run(campaign(), 1, 2, req('uguale'));
    expect(p.calls).toHaveLength(2);
  });
});

describe('ruoli senza budget: testo deterministico', () => {
  it('callStructured non chiede il repair né scrive nel registro quando la chiamata non parte', async () => {
    const p = counting();
    const b = new LlmBudget(singleRouting(p), { callsPerTurn: 0 });
    const log: LlmCall[] = [];
    const r = await callStructured(b.view(campaign(), 1, 2), log, { turn: 1 }, req('x'), z.object({ ok: z.boolean() }));
    expect(r).toMatchObject({ value: null, skipped: 'budget', repairAttempts: 0 });
    expect(r.errors[0]).toMatch(/chiamata LLM non fatta/);
    expect(log).toHaveLength(0);
    expect(p.calls).toHaveLength(0);
  });

  /** Una campagna a regole con un tetto basso: il turno si chiude sempre, le chiamate per turno non superano il tetto, il resto è testo deterministico. */
  async function play(calls: number, turns: number) {
    const mock = new MockLLMProvider();
    const store = new JsonStore(tmp());
    const e = new Engine(store, new LlmAgents(mock, new LlmBudget(singleRouting(mock), { callsPerTurn: calls })));
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'budget', seed: 'budget', config: { factionMode: 'rules' } });
    while (c.currentTurn < turns) c = await e.advance(c.id);
    return { e, c, mock, store };
  }

  it('con 3 chiamate per turno: mai più di 3 per turno, briefing e notizie dai fatti quando mancano', async () => {
    const { c, mock, store } = await play(3, 4);
    const usage = (await store.getLlmUsage(c.id))!;
    for (const [t, u] of Object.entries(usage.turns)) { expect(u.admitted, `turno ${t}`).toBeLessThanOrEqual(3); expect(u.calls, `turno ${t}`).toBeLessThanOrEqual(3); }
    expect(Object.values(usage.turns).reduce((a, u) => a + u.skipped, 0)).toBeGreaterThan(0);
    expect(mock.calls).toBe(Object.values(usage.turns).reduce((a, u) => a + u.calls, 0));
    // i testi esistono comunque: il briefing del turno 3 ha le sue sezioni
    const n = (await store.getNarrative(c.id, 3))!;
    expect(n.briefing.sections.length).toBeGreaterThan(0);
  }, 120_000);

  it('con 0 chiamate il gioco continua con soli testi deterministici (lettere-modello, notizie dai fatti)', async () => {
    const { c, mock, store } = await play(0, 3);
    expect(mock.calls).toBe(0);
    expect(c.currentTurn).toBe(3);
    const usage = (await store.getLlmUsage(c.id))!;
    expect(Object.values(usage.turns).every((u) => u.calls === 0 && u.admitted === 0)).toBe(true);
    const letters = (await Promise.all([1, 2, 3].map((t) => store.getLetters(c.id, t)))).flat();
    expect(letters.length).toBeGreaterThan(0);
    const decisions = await store.getDecision(c.id, 2, 'USA');
    expect(decisions!.letters.every((l) => l.source === 'template')).toBe(true);
  }, 120_000);
});

describe('stato', () => {
  it('lo stato riporta contatori per turno e per giorno', async () => {
    const b = new LlmBudget(singleRouting(counting()), { callsPerTurn: 5, cache: false });
    await b.run(campaign(), 3, 0, req('a', 'order_parser'));
    const st = await b.status(campaign(), 3);
    expect(st.campaign!.today).toMatchObject({ calls: 1, admitted: 1 });
    expect(Object.keys(st.campaign!.days)).toHaveLength(1);
    expect(st.campaign!.turns['3']!.byRole).toEqual({ order_parser: 1 });
    expect(emptyUsage()).toEqual({ schemaVersion: 1, turns: {}, days: {} });
  });
});
