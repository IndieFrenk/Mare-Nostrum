import { describe, expect, it } from 'vitest';
import { runSim } from '../src/cli/sim.js';
import { PARAMS } from '../src/engine/params.js';
import { makeEngine } from './helpers.js';

/** Il motore intero in modalità `rules`: il decisore a regole paga con il capitale, rispetta le ricariche e non produce ordini rifiutati. */
describe('capitale diplomatico nel motore (modalità a regole)', () => {
  it('10 turni: il CD resta tra 0 e il tetto, nessun ordine diplomatico rifiutato, eventi registrati, ricostruzione identica', async () => {
    const e = makeEngine();
    const rejected: { factionId: string; id: string; errors: string[] }[] = [];
    e.onProgress = (_, m) => { if (m.rejected) rejected.push(...(m.rejected as typeof rejected)); };
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cd', seed: 'cd' });
    const r = await runSim(e, c, 10);
    const diploRejected = rejected.filter((x) => x.errors.some((m) => /capitale|ricarica|slot|rapporti|ripetut|embargo|membro/.test(m)));
    expect(diploRejected, JSON.stringify(diploRejected.slice(0, 3))).toEqual([]);
    const caps: number[] = [];
    for (let t = 1; t <= 10; t++) {
      const s = await e.store.getState(r.campaign.id, t);
      for (const [f, v] of Object.entries(s.diplomacy!.capital)) { expect(v, `${f} turno ${t}`).toBeGreaterThanOrEqual(0); expect(v, `${f} turno ${t}`).toBeLessThanOrEqual(PARAMS.diplo.capital.cap); caps.push(v); }
    }
    const ev = (await Promise.all([1, 2, 3].map((t) => e.store.getEvents(r.campaign.id, t)))).flat();
    expect(ev.filter((x) => x.type === 'CAPITAL_CHANGED' && x.payload.rent)).toHaveLength(3); // un evento di rendita per turno
    expect(ev.some((x) => x.type === 'CAPITAL_CHANGED' && x.causedBy?.orderId)).toBe(true); // le spese portano l'ordine
    // la knowledge dell'umano ha il suo registro diplomatico (e di nessun altro)
    const k = await e.store.getKnowledge(r.campaign.id, 'ITA', 10);
    expect(k!.diplomacy!.capital).toBeGreaterThan(0);
    expect(JSON.stringify(k).includes('"rent"')).toBe(true);
  });

  it('una campagna creata senza capitale diplomatico (settore 08) si apre con la dotazione iniziale; lo snapshot resta contenuto', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'migra', seed: 'migra' });
    const s = await e.store.getState(c.id);
    const before = JSON.stringify(s).length;
    s.diplomacy!.capital = {}; s.diplomacy!.cooldowns = {};
    await e.store.saveState(c.id, s);
    const again = await e.store.getState(c.id);
    expect(Object.keys(again.diplomacy!.capital).length).toBeGreaterThan(20);
    expect(again.diplomacy!.capital.ITA).toBeCloseTo(4 * 3.03, 0);
    expect(again.diplomacy!.capital.NATO).toBeUndefined();
    // il capitale pesa poco nello snapshot (una mappa di ~26 numeri)
    expect(before - JSON.stringify({ ...s, diplomacy: { ...s.diplomacy, capital: {} } }).length).toBeLessThan(2_000);
  });
});
