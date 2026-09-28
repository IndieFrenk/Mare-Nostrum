import { describe, expect, it } from 'vitest';
import { loadScenario } from '../src/engine/scenario.js';
import { migrate } from '../src/store/migrations/index.js';
import { runSim } from '../src/cli/sim.js';
import { makeEngine } from './helpers.js';

const inside = ([x, y]: number[], poly: number[][][]) => poly.some((ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!; const [xj, yj] = ring[j]!;
    if (yi! > y! !== yj! > y! && x! < ((xj! - xi!) * (y! - yi!)) / (yj! - yi!) + xi!) c = !c;
  }
  return c;
});

describe('geografia', () => {
  it('ogni centro zona cade nel poligono ritagliato sulla costa', () => {
    const sc = loadScenario('med-2026');
    const fc = sc.geo.zones as { features: { id: string; geometry: { coordinates: number[][][][] } }[] };
    for (const f of fc.features) {
      const z = sc.world.zones[f.id]!;
      expect(f.geometry.coordinates.some((p) => inside([z.center.lon, z.center.lat], p)), f.id).toBe(true);
    }
  });
});

describe('revisione di fine turno', () => {
  it('minaccia non mantenuta → credibilità −4 due turni dopo; obiettivi aggiornati; eventi di contatto', async () => {
    const e = makeEngine();
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'rev', seed: 'rev' });
    await e.submitOrders(c.id, { military: [], diplomacy: [{ id: 't', kind: 'THREAT', target: 'LBY_LNA', message: 'Giù le mani da Mellitah', visibility: 'public' }], procurement: [], statements: [] });
    c = (await runSim(e, c, 3)).campaign;
    const ev3 = await e.store.getEvents(c.id, 3);
    expect(ev3.some((x) => x.type === 'FACTION_CHANGED' && x.actor === 'ITA' && String((x.payload as { note?: string }).note).includes('non mantenuta'))).toBe(true);
    const s = await e.store.getState(c.id);
    expect(s.factions.ITA!.objectives.length).toBe(3);
    expect(s.factions.ITA!.objectives.some((o) => o.progress > 0)).toBe(true);
    const ev1 = await e.store.getEvents(c.id, 1);
    expect(ev1.filter((x) => x.type === 'CONTACT_DETECTED' && x.actor === 'ITA').length).toBeGreaterThan(0);
    expect(JSON.stringify(ev1.filter((x) => x.type === 'CONTACT_DETECTED'))).not.toContain('truthUnitId');
  }, 30_000);

  it('config in corsa: turno mensile e CMO su richiesta; perdite nemiche confermate via ISR', async () => {
    const e = makeEngine();
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cfg', seed: 'cfg' });
    c = await e.configure(c.id, { turnLength: 'month', cmoOnRequest: true, llm: { faction_major: { model: 'wargame-strong' } } });
    expect(c.config.llm.faction_major.model).toBe('wargame-strong');
    await e.submitOrders(c.id, { military: [{ id: 's', kind: 'STRIKE', unitIds: ['ITA-TORNADO'], targetRef: 'HORMUZ', munitions: { STORM_SHADOW: 2 }, roe: 'WEAPONS_FREE' }], diplomacy: [], procurement: [], statements: [] });
    c = await e.advance(c.id);
    expect(c.phase).toBe('CMO_PENDING'); // 2 vettori: sotto soglia, ma CMO richiesto dal giocatore
    const eng = Object.values((await e.store.getState(c.id)).engagements)[0]!;
    await e.submitAar(c.id, eng.id, { submittedAt: 'x', ownLosses: [], munitionsExpended: {}, enemyClaims: [{ classification: 'motovedette', result: 'destroyed' }], outcome: 'victory', notes: '' });
    // altri ingaggi dello stesso turno con unità italiane (anche CMO su richiesta): risoluzione automatica
    for (const x of Object.values((await e.store.getState(c.id)).engagements).filter((x) => x.status === 'pending_cmo')) await e.submitAar(c.id, x.id, { autoResolve: true });
    c = await e.advance(c.id);
    expect(c.date).toBe('2026-04-08'); // turno 1 al 9 marzo + 30 giorni
    const s = await e.store.getState(c.id);
    expect(s.engagements[eng.id]!.enemyLossesConfirmed).toBeDefined();
  }, 30_000);

  it('migrazioni: rifiuta file più recenti del server', () => {
    expect(migrate({ schemaVersion: 1, a: 1 })).toEqual({ schemaVersion: 1, a: 1 });
    expect(() => migrate({ schemaVersion: 99 })).toThrow();
  });
});
