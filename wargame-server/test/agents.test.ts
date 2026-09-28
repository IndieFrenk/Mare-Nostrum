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
