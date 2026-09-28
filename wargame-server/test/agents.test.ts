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
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'r', seed: 'repair', config: { factionMode: 'llm' } });
    await e.advance(c.id);
    const ds = await Promise.all(['CHN', 'FRA', 'RUS', 'TUR', 'USA'].map((f) => e.store.getDecision(c.id, 1, f)));
    const repaired = ds.filter((d) => d!.validation.repairAttempts === 1);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.validation.fallbackUsed).toBe(false);
  });

  it('repair fallito → fallback dottrinale', async () => {
    const e = makeEngine(new MockLLMProvider({ corrupt: { faction_minor: 99 }, corruptRepair: true }));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'f', seed: 'fallback', config: { factionMode: 'llm' } });
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

  it('il mock produce posture per zona deterministiche, tradotte in ordini con unità', async () => {
    const run = async () => {
      const e = makeEngine();
      const c = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'm', seed: 'mock-stances', config: { factionMode: 'llm' } }), 2)).campaign;
      return Promise.all(AI.map((f) => e.store.getDecision(c.id, 1, f)));
    };
    const [a, b] = [await run(), await run()];
    expect(a.map((d) => [d!.zoneStances, d!.stanceOrders, d!.orders.military])).toEqual(b.map((d) => [d!.zoneStances, d!.stanceOrders, d!.orders.military]));
    for (const d of a) {
      expect(d!.zoneStances.length).toBeGreaterThan(0);
      expect(d!.stanceOrders.length).toBeGreaterThan(0);
      const ids = new Set(d!.orders.military.map((o) => o.id));
      for (const s of d!.stanceOrders) expect(ids.has(s.orderId)).toBe(true);
    }
  }, 30_000);

  it('replay identico anche con le posture (ordini già tradotti nelle decisioni salvate)', async () => {
    const e = makeEngine();
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'src', seed: 'replay-stances', config: { factionMode: 'llm' } }), 3)).campaign;
    const stanceOrders = (await Promise.all(AI.map((f) => e.store.getDecision(src.id, 2, f)))).flatMap((d) => d!.stanceOrders);
    expect(stanceOrders.length).toBeGreaterThan(AI.length / 2);
    const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
    const c = await replay.createCampaign({ scenarioId: 'med-2026', name: 'rep', seed: src.seed, config: src.config });
    const r = await runSim(replay, c, 3, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(c.id, o); });
    for (let t = 1; t <= 3; t++) expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(src.id, t));
    const again = await e.store.getDecision(r.campaign.id, 2, 'TUR');
    expect(again!.stanceOrders).toEqual((await e.store.getDecision(src.id, 2, 'TUR'))!.stanceOrders);
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
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cad', seed: 'cadenza', config: { factionMode: 'llm',  agentCadence: { minorEvery: 2, reflectEvery: 3 } } });
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
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'drop', seed: 'drop', config: { factionMode: 'llm' } });
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

describe('tetti agli ordini per turno', () => {
  it('liste troppo lunghe vengono tagliate invece di scartare la decisione', async () => {
    const { ORDER_CAPS } = await import('../src/agents/faction-agent.js');
    const mock = new MockLLMProvider();
    const provider = { name: 'logorroico', complete: async (r: Parameters<MockLLMProvider['complete']>[0]) => {
      const res = await mock.complete(r);
      if (r.role !== 'faction_major' || r.meta.factionId !== 'TUR') return res;
      const d = JSON.parse(res.text);
      d.orders.statements = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, audience: 'opinione pubblica', text: `Dichiarazione ${i}`, tone: 'firm' }));
      return { ...res, text: JSON.stringify(d) };
    } };
    const e = makeEngine(provider as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cap', seed: 'cap', config: { factionMode: 'llm' } });
    await e.advance(c.id);
    const d = (await e.store.getDecision(c.id, 1, 'TUR'))!;
    expect(d.validation.fallbackUsed).toBe(false);
    expect(d.orders.statements).toHaveLength(ORDER_CAPS.statements);
  }, 30_000);
});

describe('limiti realistici agli ordini IA', () => {
  it('troppe operazioni cyber, asset ISR ripetuti e budget superato: si tolgono gli ordini in eccesso', async () => {
    const mock = new MockLLMProvider();
    const provider = { name: 'esagerato', complete: async (r: Parameters<MockLLMProvider['complete']>[0]) => {
      const res = await mock.complete(r);
      if (!String(r.role).startsWith('faction') || !['TUR', 'LBY_LNA'].includes(String(r.meta.factionId))) return res;
      const d = JSON.parse(res.text);
      if (r.meta.factionId === 'TUR') {
        d.orders.military = [
          ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, kind: 'CYBER_OP', target: 'GRC', targetRef: 'rete elettrica', effect: 'espionage' })),
          { id: 'i1', kind: 'ISR', assetIds: ['TUR-GOKTURK'], zoneId: 'EGEO' }, { id: 'i2', kind: 'ISR', assetIds: ['TUR-GOKTURK'], zoneId: 'MEDITERRANEO_ORIENTALE' },
        ];
      } else d.orders.diplomacy = [{ id: 'a1', kind: 'AID', target: 'TUR', amount: 5000, type: 'economic' }];
      return { ...res, text: JSON.stringify(d) };
    } };
    const e = makeEngine(provider as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'limiti', seed: 'limiti', config: { factionMode: 'llm' } });
    await e.advance(c.id);
    const tur = (await e.store.getDecision(c.id, 1, 'TUR'))!;
    expect(tur.validation.fallbackUsed).toBe(false);
    expect(tur.orders.military.filter((o) => o.kind === 'CYBER_OP')).toHaveLength(2);
    expect(tur.orders.military.filter((o) => o.kind === 'ISR')).toHaveLength(1);
    const lna = (await e.store.getDecision(c.id, 1, 'LBY_LNA'))!;
    expect(lna.validation.fallbackUsed).toBe(false);
    expect(lna.orders.diplomacy.some((o) => o.kind === 'AID')).toBe(false);
    expect(lna.validation.errors.some((x) => x.includes('oltre il budget'))).toBe(true);
  }, 30_000);
});

describe('errori del validatore legati all\'ordine', () => {
  it('una zona inventata porta l\'id dell\'ordine (così l\'ordine si può scartare da solo)', async () => {
    const { validateOrders } = await import('../src/engine/validators.js');
    const { loadScenario } = await import('../src/engine/scenario.js');
    const sc = loadScenario('med-2026');
    const v = validateOrders(sc.world, sc.catalog, 'ITA', { military: [{ id: 'z1', kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'EGEO_MEDITERRANEO_ORT', roe: 'WEAPONS_TIGHT' }], diplomacy: [], procurement: [], statements: [] });
    expect(v.errors).toContain('z1: zona sconosciuta: EGEO_MEDITERRANEO_ORT');
  });
});
