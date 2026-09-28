import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { ReplayAgents } from '../src/agents/replay.js';
import { extractJson } from '../src/agents/llm-client.js';
import { numbersNotInFacts } from '../src/agents/repair.js';
import { Engine } from '../src/engine/turn-machine.js';
import { runSim } from '../src/cli/sim.js';
import { makeEngine } from './helpers.js';

const AI = ['ALG', 'CHN', 'EGY', 'FRA', 'GBR', 'GRC', 'IRN', 'ISR', 'LBY_GNU', 'LBY_LNA', 'RUS', 'TUN', 'TUR', 'USA'];

describe('agenti', () => {
  it('ogni fazione IA produce una decisione valida ogni turno', async () => {
    const e = makeEngine();
    const r = await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'a', seed: 'agents' }), 3);
    for (let t = 1; t <= 3; t++) for (const f of AI) {
      const d = (await e.store.getDecision(r.campaign.id, t, f))!;
      expect(d.validation).toMatchObject({ valid: true, fallbackUsed: false });
      expect(d.orders.source).toBe('ai');
    }
  }, 30_000);

  it('JSON invalido → repair → decisione valida', async () => {
    const e = makeEngine(new MockLLMProvider({ corrupt: { faction_major: 1 } }));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'r', seed: 'repair' });
    await e.advance(c.id);
    const ds = await Promise.all(['CHN', 'FRA', 'RUS', 'TUR', 'USA'].map((f) => e.store.getDecision(c.id, 1, f)));
    const repaired = ds.filter((d) => d!.validation.repairAttempts === 1);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.validation.fallbackUsed).toBe(false);
  });

  it('repair fallito → fallback dottrinale', async () => {
    const e = makeEngine(new MockLLMProvider({ corrupt: { faction_minor: 99 }, corruptRepair: true }));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'f', seed: 'fallback' });
    await e.advance(c.id);
    const d = (await e.store.getDecision(c.id, 1, 'GRC'))!;
    expect(d.validation).toMatchObject({ fallbackUsed: true, repairAttempts: 2, valid: false });
    expect(d.orders.source).toBe('fallback_doctrine');
    const log = await import('node:fs/promises').then((fs) => fs.readFile(e.store.dir(c.id, 'llm-log', 'turn-0001.jsonl'), 'utf8'));
    expect(log).toContain('"ok":false');
  });

  it('replay da decisions/ produce stati identici senza chiamare LLM', async () => {
    const e = makeEngine();
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'src', seed: 'replay' }), 3)).campaign;
    const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
    const c = await replay.createCampaign({ scenarioId: 'med-2026', name: 'rep', seed: src.seed });
    const r = await runSim(replay, c, 3, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(c.id, o); });
    for (let t = 1; t <= 3; t++) expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(src.id, t));
  }, 30_000);

  it('validatore numeri del narratore', () => {
    expect(numbersNotInFacts('FOED a 3200 M€, 5 unità', ['FOED disponibile: 3200 M€.', '5 unità schierate'])).toEqual([]);
    expect(numbersNotInFacts('Perse 3 fregate', ['nessuna perdita'])).toEqual(['3']);
    expect(numbersNotInFacts('Tensione in Egeo (F3-2, F3-E1; D3-14).', ['tensione in Egeo'])).toEqual([]);
  });

  it('estrae JSON da testo con prosa e stringhe con parentesi', () => {
    expect(extractJson('Ecco: ```json\n{"a":"x}\\"y","b":{"c":1}}\n``` fine')).toEqual({ a: 'x}"y', b: { c: 1 } });
  });

  it('order parser (mock) produce bozza e ambiguità', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'p', seed: 'parser' });
    const ok = await e.parseOrders(c.id, 'Pattugliare CANALE_SICILIA con ITA-F592');
    expect(ok.orders.military[0]).toMatchObject({ kind: 'PATROL', zoneId: 'CANALE_SICILIA', unitIds: ['ITA-F592'] });
    expect(ok.validation.valid).toBe(true);
    const amb = await e.parseOrders(c.id, 'fate qualcosa');
    expect(amb.ambiguities.length).toBeGreaterThan(0);
  });
});

describe('riflessione: note sulle relazioni scritte come oggetti', () => {
  it('le riduce a una frase invece di scartare la memoria', async () => {
    const { noteText } = await import('../src/agents/reflection.js');
    expect(noteText('già una frase')).toBe('già una frase');
    expect(noteText({ trust: -2, tension: 3, note: 'proposta sul Mar Rosso' })).toBe('proposta sul Mar Rosso — trust -2, tension 3');
    expect(noteText({ trust: 0, tension: 0, notes: [] })).toBe('trust 0, tension 0');
    expect(noteText({ EGY: { note: 'x' } })).toBe('{"EGY":{"note":"x"}}');
  });
});

describe('cadenza degli agenti (risparmio di chiamate LLM)', () => {
  it('fazioni minori a turni alterni e memoria IA ogni 3 turni: meno chiamate, decisioni per tutti, replay identico', async () => {
    const calls: string[] = [];
    const mock = new MockLLMProvider();
    const spy = { name: 'spy', complete: (r: Parameters<MockLLMProvider['complete']>[0]) => { calls.push(r.role); return mock.complete(r); } };
    const e = makeEngine(spy as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cad', seed: 'cadenza', config: { agentCadence: { minorEvery: 2, reflectEvery: 3 } } });
    const src = (await runSim(e, c, 4)).campaign;
    const count = (role: string) => calls.filter((x) => x === role).length;
    // 9 minori × 4 turni = 36 → circa la metà; 14 riflessioni × 4 turni = 56 → circa un terzo
    expect(count('faction_minor')).toBeLessThanOrEqual(20);
    expect(count('faction_major')).toBe(5 * 4);
    expect(count('reflection')).toBeLessThanOrEqual(22);
    for (let t = 1; t <= 4; t++) for (const f of AI) expect(await e.store.getDecision(src.id, t, f)).not.toBeNull();
    const skipped = (await Promise.all(AI.map((f) => e.store.getDecision(src.id, 2, f)))).filter((d) => d!.model === 'dottrina');
    expect(skipped.length).toBeGreaterThan(0);
    expect((await e.store.getMemory(src.id, 'TUR'))!.updatedTurn).toBe(4);
    const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
    const rc = await replay.createCampaign({ scenarioId: 'med-2026', name: 'rep', seed: src.seed, config: src.config });
    const r = await runSim(replay, rc, 4, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(rc.id, o); });
    for (let t = 1; t <= 4; t++) expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(src.id, t));
  }, 60_000);
});

describe('ordini impossibili scartati invece di buttare la decisione', () => {
  it('un ordine ISR con un asset inventato viene tolto, il resto della decisione resta valido', async () => {
    const mock = new MockLLMProvider();
    const provider = { name: 'bugiardo', complete: async (r: Parameters<MockLLMProvider['complete']>[0]) => {
      const res = await mock.complete(r);
      if (r.role !== 'faction_major' || r.meta.factionId !== 'TUR') return res;
      const d = JSON.parse(res.text);
      d.orders.military.push({ id: 'x', kind: 'ISR', assetIds: ['TUR-SATELLITE-INVENTATO'], zoneId: 'EGEO' });
      return { ...res, text: JSON.stringify(d) };
    } };
    const e = makeEngine(provider as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'drop', seed: 'drop' });
    await e.advance(c.id);
    const d = (await e.store.getDecision(c.id, 1, 'TUR'))!;
    expect(d.validation).toMatchObject({ valid: true, fallbackUsed: false, repairAttempts: 0 });
    expect(d.validation.errors.some((x) => x.startsWith('scartato') && x.includes('TUR-SATELLITE-INVENTATO'))).toBe(true);
    expect(d.orders.military.some((o) => o.kind === 'ISR' && o.assetIds.includes('TUR-SATELLITE-INVENTATO'))).toBe(false);
  }, 30_000);

  it('il prompt di una fazione senza asset ISR non mostra il formato ISR', async () => {
    const { trimFormat } = await import('../src/agents/faction-agent.js');
    const s = 'A\n- ISR: {...}\n- SOF_OP: {...}\n- PATROL, PRESENCE: {...}';
    expect(trimFormat(s, ['PATROL', 'PRESENCE'])).toBe('A\n- PATROL, PRESENCE: {...}');
    expect(trimFormat(s, ['ISR', 'SOF_OP', 'PATROL'])).toBe(s);
  });
});
