import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { runSim } from '../src/cli/sim.js';
import { agentFactions } from '../src/engine/turn-machine.js';
import { makeEngine } from './helpers.js';

/** Mock che conta le chiamate per ruolo. */
class Counting extends MockLLMProvider {
  roles: string[] = [];
  override async complete(req: LlmRequest) { this.roles.push(req.role); return super.complete(req); }
}
const FACTION_ROLES = ['faction_major', 'faction_minor', 'reflection'];

describe('modalità delle fazioni', () => {
  it('rules (predefinita): fazioni IA «scripted», nessuna chiamata di decisione o riflessione, decisioni a regole registrate', async () => {
    const p = new Counting();
    const e = makeEngine(p);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'regole', seed: 'regole' });
    expect(c.config.factionMode).toBe('rules');
    const s0 = await e.store.getState(c.id, 0);
    expect(s0.factions.TUR!.controller).toBe('scripted');
    expect(s0.factions.ITA!.controller).toBe('human');
    const agents = agentFactions(s0);
    expect(agents).toContain('USA');
    expect(agents).not.toContain('NATO');
    const r = await runSim(e, c, 3);
    expect(p.roles.filter((x) => FACTION_ROLES.includes(x))).toEqual([]);
    expect(p.roles).toContain('gm_narrator');
    let unitOrders = 0; let fromStances = 0; let withRationale = 0;
    for (let t = 1; t <= 3; t++) for (const f of agents) {
      const d = (await e.store.getDecision(r.campaign.id, t, f))!;
      expect(d.model).toBe('regole');
      expect(d.validation).toMatchObject({ valid: true, fallbackUsed: false, repairAttempts: 0 });
      expect(d.usage).toEqual({ promptTokens: 0, completionTokens: 0, latencyMs: 0 });
      unitOrders += d.orders.military.filter((o) => 'unitIds' in o && o.unitIds.length).length;
      fromStances += d.stanceOrders.length;
      if (d.rationale.length) withRationale++;
    }
    expect(unitOrders).toBeGreaterThan(agents.length * 3);
    expect(fromStances).toBeGreaterThan(0);
    expect(withRationale).toBe(agents.length * 3);
    // tiri del decisore nel registro dei dadi
    expect((await e.store.getRolls(r.campaign.id, 1)).some((x) => x.purpose.startsWith('regole '))).toBe(true);
    // memoria deterministica: cosa ho subito, cosa ho fatto
    const m = (await e.store.getMemory(r.campaign.id, 'TUR'))!;
    expect(m.updatedTurn).toBe(3);
    expect(m.rollingSummary).toMatch(/T3: subito .*; fatto: /);
  }, 30_000);

  it('rules chiama l\'LLM molte meno volte di llm a parità di turni', async () => {
    const count = async (factionMode: 'rules' | 'llm') => {
      const p = new Counting();
      const e = makeEngine(p);
      await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: factionMode, seed: 'conta', config: { factionMode } }), 2);
      return p.roles;
    };
    const [rules, llm] = [await count('rules'), await count('llm')];
    expect(llm.filter((x) => FACTION_ROLES.includes(x)).length).toBeGreaterThan(20);
    expect(rules.length * 3).toBeLessThan(llm.length);
  }, 30_000);
});
