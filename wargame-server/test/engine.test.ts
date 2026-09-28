import { beforeAll, describe, expect, it } from 'vitest';
import type { Campaign } from '../src/schemas/index.js';
import { rebuild } from '../src/engine/reducer.js';
import { runSim } from '../src/cli/sim.js';
import { makeEngine } from './helpers.js';

describe('motore: 5 turni headless con mock', () => {
  const e = makeEngine();
  let c: Campaign;
  let deliveryTurn = 0;
  beforeAll(async () => {
    c = await e.createCampaign({ scenarioId: 'med-2026', name: 'engine', seed: 'engine-seed' });
    const r = await runSim(e, c, 5, async (turn) => {
      if (turn !== 1) return;
      const { validation } = await e.submitOrders(c.id, {
        military: [{ id: 'm1', kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' }, { id: 'm2', kind: 'ISR', assetIds: ['ITA-CSK'], zoneId: 'MAR_LIBICO' }],
        diplomacy: [{ id: 'd1', kind: 'REASSURANCE', target: 'LBY_GNU', message: 'Sostegno alla guardia costiera', visibility: 'public' }],
        procurement: [{ id: 'p1', itemId: 'LOT_METEOR', qty: 2, destinationBaseId: 'TRAPANI' }, { id: 'p2', itemId: 'PLT_MQ9B', qty: 1, destinationBaseId: 'SIGONELLA' }],
        statements: [],
      });
      expect(validation.valid).toBe(true);
    });
    c = r.campaign;
    deliveryTurn = (await e.store.getState(c.id, 1)).pendingDeliveries.find((d) => d.itemId === 'LOT_METEOR' && d.factionId === 'ITA')!.deliveryTurn;
  }, 60_000);

  it('arriva al turno 6 in attesa del giocatore', () => {
    expect(c.currentTurn).toBe(6);
    expect(c.phase).toBe('PLAYER_ORDERS');
  });

  it('ledger coerente: saldo = somma delle voci, per ogni fazione', async () => {
    const s = await e.store.getState(c.id);
    const ledger = await e.store.getLedger(c.id);
    for (const f of Object.values(s.factions).filter((f) => f.kind !== 'bloc')) {
      const sum = ledger.filter((l) => l.factionId === f.id).reduce((a, l) => a + l.amount, 0);
      expect(Math.round(sum * 10) / 10).toBeCloseTo(f.budget.discretionary, 1);
    }
  });

  it('knowledge ITA senza verità di terra', async () => {
    for (let t = 1; t <= 6; t++) {
      const k = (await e.store.getKnowledge(c.id, 'ITA', t))!;
      const raw = JSON.stringify(k);
      expect(raw).not.toContain('truthUnitId');
      expect(k.ownUnits.every((u) => u.factionId === 'ITA')).toBe(true);
      const enemyIds = Object.keys((await e.store.getState(c.id)).units).filter((id) => !id.startsWith('ITA-'));
      for (const id of enemyIds) expect(raw).not.toContain(`"${id}"`);
      expect(k.contacts.length).toBeGreaterThan(0);
    }
  });

  it('current = snapshot(N-1) + eventi(N) per ogni turno', async () => {
    for (let t = 1; t <= 5; t++) {
      const rebuilt = rebuild(await e.store.getState(c.id, t - 1), await e.store.getEvents(c.id, t));
      expect(rebuilt).toEqual(await e.store.getState(c.id, t));
    }
    const cur = rebuild(await e.store.getState(c.id, 5), await e.store.getEvents(c.id, 6));
    expect(cur).toEqual(await e.store.getState(c.id));
  });

  it('consegne al turno previsto', async () => {
    const arrived = (await e.store.getEvents(c.id, deliveryTurn)).filter((x) => x.type === 'DELIVERY_ARRIVED' && x.actor === 'ITA');
    expect(arrived.length).toBeGreaterThanOrEqual(1);
    const s = await e.store.getState(c.id);
    expect(s.factions.ITA.stocks.METEOR).toBe(40 + 20);
    expect(s.units['ITA-MQ9'].count).toBe(7);
  });

  it('tiri di dado registrati', async () => {
    expect((await e.store.getRolls(c.id, 2)).length).toBeGreaterThan(50);
  });
});

describe('validatori', () => {
  it('le navi non possono essere mandate in zone terrestri', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'v', seed: 'v' });
    const v = await e.validate(c.id, { military: [{ id: 'x', kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'SAHEL', roe: 'WEAPONS_TIGHT' }], diplomacy: [], procurement: [], statements: [] });
    expect(v.errors.join()).toContain('zona terrestre');
    const air = await e.validate(c.id, { military: [{ id: 'y', kind: 'PATROL', unitIds: ['ITA-MQ9'], zoneId: 'SAHEL', roe: 'WEAPONS_TIGHT' }], diplomacy: [], procurement: [], statements: [] });
    expect(air.valid).toBe(true);
  });
});

describe('CMO', () => {
  it('uno strike ≥8 vettori va in CMO_PENDING, l\'AAR sblocca e aggiorna perdite/munizioni/ledger', async () => {
    const e = makeEngine();
    let c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cmo', seed: 'cmo' });
    await e.submitOrders(c.id, { military: [{ id: 's1', kind: 'STRIKE', unitIds: ['ITA-TORNADO'], targetRef: 'HORMUZ', munitions: { STORM_SHADOW: 8 }, roe: 'WEAPONS_FREE' }], diplomacy: [], procurement: [], statements: [] });
    c = await e.advance(c.id);
    expect(c.phase).toBe('CMO_PENDING');
    const s = await e.store.getState(c.id);
    const eng = Object.values(s.engagements).find((x) => x.status === 'pending_cmo')!;
    expect(eng.cmoPackage!.headline).toBe('RISOLUZIONE SU CMO RICHIESTA');
    expect(JSON.stringify(eng.cmoPackage)).not.toContain('IRN-FAC');
    const before = s.factions.ITA.budget.discretionary;
    await e.submitAar(c.id, eng.id, { submittedAt: new Date().toISOString(), ownLosses: [{ unitId: 'ITA-TORNADO', newStatus: 'damaged', damage: 20, aircraftLost: 1 }], munitionsExpended: { STORM_SHADOW: 2 }, enemyClaims: [{ classification: 'pattugliatore', result: 'damaged' }], outcome: 'victory', notes: 'ok' });
    const after = await e.store.getState(c.id);
    expect(after.engagements[eng.id].status).toBe('resolved');
    expect(after.units['ITA-TORNADO'].count).toBe(11);
    expect(after.units['ITA-TORNADO'].loadout.STORM_SHADOW).toBe(2);
    expect(after.factions.ITA.budget.discretionary).toBeLessThan(before);
    c = await e.advance(c.id);
    expect(c.currentTurn).toBe(2);
    expect(c.phase).toBe('PLAYER_ORDERS');
  }, 30_000);
});

describe('de-escalation delle crisi (SPEC: «accordi e de-escalation la riducono»)', () => {
  it('senza incidenti le crisi si raffreddano e un cessate il fuoco accettato riduce l\'escalation', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cool', seed: 'raffreddamento' });
    await runSim(e, c, 8);
    const s = await e.store.getState(c.id);
    const causes = Object.values(s.crises).flatMap((k) => k.history.map((h) => h.cause));
    expect(causes.some((x) => x.includes('raffreddamento'))).toBe(true);
    const { deescalateByAgreement } = await import('../src/engine/crises.js');
    const deltas: [string, number, string][] = [];
    const fake = { state: s, escalate: (id: string, d: number, cause: string) => deltas.push([id, d, cause]) };
    // tregua tra due fazioni coinvolte in una crisi non risolta → −2 su quella crisi
    const open = Object.values(s.crises).find((k) => k.status !== 'resolved')!;
    deescalateByAgreement(fake as never, { id: 'AG-X', type: 'ceasefire', parties: open.involved.slice(0, 2) });
    expect(deltas.filter(([, d]) => d === -2).map(([id]) => id)).toContain(open.id);
    deltas.length = 0;
    deescalateByAgreement(fake as never, { id: 'AG-Z', type: 'defense', parties: open.involved.slice(0, 2) });
    expect(deltas).toEqual([]); // un accordo di difesa non raffredda
    deltas.length = 0;
    deescalateByAgreement(fake as never, { id: 'AG-Y', type: 'migration', parties: ['ITA', 'TUN'] });
    expect(deltas.map(([id]) => id)).toEqual(s.crises.SAHEL_MIG!.status === 'resolved' ? [] : ['SAHEL_MIG']);
  }, 60_000);
});
