import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { ReplayAgents } from '../src/agents/replay.js';
import { runSim } from '../src/cli/sim.js';
import { loadScenario } from '../src/engine/scenario.js';
import { Engine, agentFactions } from '../src/engine/turn-machine.js';
import { makeEngine } from './helpers.js';

const replayOf = async (e: Engine, srcId: string, turns: number) => {
  const src = await e.store.getCampaign(srcId);
  const replay = new Engine(e.store, new ReplayAgents(e.store, src.id));
  const c = await replay.createCampaign({ scenarioId: src.scenarioId, name: 'rep', seed: src.seed, config: src.config });
  return runSim(replay, c, turns, async (t) => { const o = await e.store.getOrders(src.id, t, 'ITA'); if (o) await e.store.saveOrders(c.id, o); });
};

describe('replay delle decisioni a regole', () => {
  it('le ricalcola con lo stesso dado: decisioni, tiri e stati identici, nessuna chiamata LLM', async () => {
    const e = makeEngine();
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'src', seed: 'replay-regole' }), 4)).campaign;
    const r = await replayOf(e, src.id, 4);
    const agents = agentFactions(await e.store.getState(src.id, 0));
    for (let t = 1; t <= 4; t++) {
      expect(await e.store.getState(r.campaign.id, t)).toEqual(await e.store.getState(src.id, t));
      expect(await e.store.getRolls(r.campaign.id, t)).toEqual(await e.store.getRolls(src.id, t));
      for (const f of agents) {
        const [a, b] = [await e.store.getDecision(src.id, t, f), await e.store.getDecision(r.campaign.id, t, f)];
        expect(b!.model).toBe('regole');
        expect({ ...b, orders: { ...b!.orders, source: 'x' } }).toEqual({ ...a, orders: { ...a!.orders, source: 'x' } });
      }
    }
    // il replay non chiama modelli: nessun registro LLM nella campagna rigiocata
    expect(readdirSync(e.store.dir(r.campaign.id)).includes('llm-log')).toBe(false);
  }, 30_000);

  it('una decisione registrata che non torna con le regole ferma il replay (REPLAY_DIVERGENT)', async () => {
    const e = makeEngine();
    const src = (await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'src', seed: 'replay-manomesso' }), 2)).campaign;
    const file = e.store.dir(src.id, 'decisions', 'turn-0002', 'TUR.json');
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d.zoneStances = [{ zoneId: 'MAR_NERO', stance: 'blockade', intensity: 3 }];
    writeFileSync(file, JSON.stringify(d));
    await expect(replayOf(e, src.id, 2)).rejects.toMatchObject({ code: 'REPLAY_DIVERGENT' });
  }, 30_000);
});

describe('campagne vecchie', () => {
  /** campagna come prima di WARGAME_FACTION_MODE: niente factionMode, controller «ai», niente policy, un nome di fazione vecchio */
  const oldCampaign = async (seed: string) => {
    const e = makeEngine(new MockLLMProvider());
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'vecchia', seed, config: { factionMode: 'llm' } });
    const cf = e.store.dir(c.id, 'campaign.json');
    const raw = JSON.parse(readFileSync(cf, 'utf8'));
    delete raw.config.factionMode;
    writeFileSync(cf, JSON.stringify(raw));
    for (const f of [e.store.dir(c.id, 'state', 'current.json'), e.store.dir(c.id, 'state', 'turn-0000.json')]) {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      for (const x of Object.values(s.factions) as Record<string, unknown>[]) delete x.policy;
      (s.factions.LBY_LNA as Record<string, unknown>).name = 'Libia (nome vecchio)';
      writeFileSync(f, JSON.stringify(s));
    }
    return { e, id: c.id };
  };
  const withMode = async <T>(mode: string, fn: () => Promise<T>) => {
    process.env.WARGAME_FACTION_MODE = mode;
    try { return await fn(); } finally { delete process.env.WARGAME_FACTION_MODE; }
  };

  it('in lettura profilo policy e nome delle fazioni dallo scenario, senza riscrivere i file', async () => {
    const { e, id } = await oldCampaign('vecchia-policy');
    const file = e.store.dir(id, 'state', 'current.json');
    const before = readFileSync(file, 'utf8');
    const s = await e.store.getState(id);
    expect(s.factions.TUR!.policy).toEqual(loadScenario('med-2026').world.factions.TUR!.policy);
    expect(s.factions.LBY_LNA!.name).toBe(loadScenario('med-2026').world.factions.LBY_LNA!.name);
    expect(s.factions.TUR!.controller).toBe('ai');
    expect(readFileSync(file, 'utf8')).toBe(before);
  }, 30_000);

  it('continuano a funzionare in entrambe le modalità (quella del server)', async () => {
    const { e, id } = await oldCampaign('vecchia-modi');
    // WARGAME_FACTION_MODE=rules: le fazioni «ai» decidono a regole
    let c = await withMode('rules', () => e.advance(id));
    expect(c.currentTurn).toBe(2);
    expect((await e.store.getDecision(id, 1, 'TUR'))!.model).toBe('regole');
    // WARGAME_FACTION_MODE=llm: di nuovo gli agenti LLM
    c = await withMode('llm', () => e.advance(id));
    expect(c.currentTurn).toBe(3);
    expect((await e.store.getDecision(id, 2, 'TUR'))!.model).toBe('mock');
  }, 30_000);
});
