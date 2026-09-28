import { describe, expect, it } from 'vitest';
import { loadScenario } from '../src/engine/scenario.js';

describe('profilo policy dello scenario', () => {
  it('ogni fazione non giocata dall\'umano (tranne i blocchi) ha un profilo con zone esistenti', () => {
    const sc = loadScenario('med-2026');
    const agents = Object.values(sc.world.factions).filter((f) => f.controller !== 'human' && f.kind !== 'bloc');
    expect(agents.length).toBeGreaterThanOrEqual(14);
    for (const f of agents) {
      expect(f.policy, f.id).toBeDefined();
      for (const z of Object.keys(f.policy!.zoneInterests)) expect(sc.world.zones[z], `${f.id}: zona ${z}`).toBeDefined();
    }
    // il giocatore e i blocchi non decidono con le regole
    expect(sc.world.factions.ITA!.policy).toBeUndefined();
    expect(sc.world.factions.NATO!.policy).toBeUndefined();
  });
});
