import { describe, expect, it } from 'vitest';
import type { Unit } from '../src/schemas/index.js';
import type { LlmProvider } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { loadScenario } from '../src/engine/scenario.js';
import { stanceForces, translateStances } from '../src/engine/stances.js';
import { makeEngine } from './helpers.js';

const sc = loadScenario('med-2026');
const zones = sc.world.zones;
const unitsOf = (f: string) => Object.values(structuredClone(sc.world.units)).filter((u) => u.factionId === f);
const base = { zones, budget: 1000, turnLength: 'week' as const };
const idsOf = (o: { unitIds?: string[] }) => o.unitIds ?? [];

describe('posture per zona → ordini (traduttore deterministico)', () => {
  it('dominio giusto: navi in mare, sam_battery per la difesa aerea, niente navi nelle zone terrestri', () => {
    const units = unitsOf('ITA');
    const r = translateStances({ ...base, units, stances: [
      { zoneId: 'EGEO', stance: 'patrol', intensity: 2 },
      { zoneId: 'IONIO', stance: 'air_defense', intensity: 1 },
      { zoneId: 'LIBIA_TERRA', stance: 'presence', intensity: 1 },
    ] });
    const [patrol, ad, land] = r.orders;
    expect(patrol).toMatchObject({ kind: 'PATROL', zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' });
    for (const id of idsOf(patrol as never)) expect(['frigate', 'opv', 'destroyer', 'submarine']).toContain(sc.world.units[id]!.type);
    expect(ad).toMatchObject({ kind: 'AIR_DEFENSE', zoneId: 'IONIO', alert: 'high' });
    expect(sc.world.units[idsOf(ad as never)[0]!]!.type).toBe('sam_battery');
    expect(land).toMatchObject({ kind: 'PRESENCE', zoneId: 'LIBIA_TERRA', roe: 'WEAPONS_HOLD' });
    for (const id of idsOf(land as never)) expect(['sea', 'subsurface']).not.toContain(sc.world.units[id]!.domain);
    expect(r.origins.map((o) => o.stance)).toEqual(['patrol', 'air_defense', 'presence']);
  });

  it('postura → tipo di ordine e ROE; blocco e scorta solo in mare', () => {
    const r = translateStances({ ...base, units: unitsOf('ITA'), stances: [
      { zoneId: 'CANALE_SICILIA', stance: 'escort_shipping', intensity: 1 }, { zoneId: 'MAR_LIBICO', stance: 'blockade', intensity: 1 },
      { zoneId: 'EGEO', stance: 'show_of_force', intensity: 1 }, { zoneId: 'SAHEL', stance: 'blockade', intensity: 1 },
    ] });
    expect(r.orders.map((o) => [o.kind, 'roe' in o ? o.roe : null])).toEqual([['ESCORT', 'WEAPONS_TIGHT'], ['BLOCKADE', 'WEAPONS_TIGHT'], ['SHOW_OF_FORCE', 'WEAPONS_TIGHT']]);
    expect(r.orders[0]).toMatchObject({ protect: 'convoglio CANALE_SICILIA' });
    expect(r.notes.join()).toContain('postura blockade in SAHEL: postura possibile solo in zone di mare');
  });

  it('intensità = numero di unità (1 → 1, 2 → fino a 3, 3 → fino a 5) e nessuna unità in due ordini', () => {
    const units = unitsOf('ITA');
    const r = translateStances({ ...base, units, exclude: ['ITA-F590'], stances: [
      { zoneId: 'TIRRENO', stance: 'patrol', intensity: 1 }, { zoneId: 'IONIO', stance: 'patrol', intensity: 2 }, { zoneId: 'EGEO', stance: 'presence', intensity: 3 },
    ] });
    expect(r.orders.map((o) => idsOf(o as never).length)).toEqual([1, 3, 5]);
    const all = r.orders.flatMap((o) => idsOf(o as never));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('ITA-F590'); // già in un ordine esplicito
    // si preferiscono le unità già nella zona
    expect(sc.world.units[idsOf(r.orders[0] as never)[0]!]!.zoneId).toBe('TIRRENO');
  });

  it('pochi mezzi: si impiega quello che c\'è e lo si annota', () => {
    const r = translateStances({ ...base, units: unitsOf('TUN'), stances: [{ zoneId: 'CANALE_SICILIA', stance: 'patrol', intensity: 3 }, { zoneId: 'IONIO', stance: 'air_defense', intensity: 1 }] });
    expect(r.orders).toHaveLength(1);
    expect(idsOf(r.orders[0] as never)).toEqual(['TUN-OPV1', 'TUN-OPV2']);
    expect(r.notes).toEqual(['postura patrol in CANALE_SICILIA: 2 unità su 5 richieste', 'postura air_defense in IONIO: nessuna unità adatta disponibile']);
  });

  it('withdraw: rientro alla base delle unità schierate in quella zona', () => {
    const units = unitsOf('ITA');
    const r = translateStances({ ...base, units, stances: [{ zoneId: 'MAR_LIBICO', stance: 'withdraw', intensity: 1 }, { zoneId: 'TIRRENO', stance: 'withdraw', intensity: 1 }] });
    expect(r.orders).toEqual([{ id: 'stance-1', kind: 'RETURN_TO_BASE', unitIds: ['ITA-P431'] }]);
    expect(r.origins).toEqual([{ stance: 'withdraw', zoneId: 'MAR_LIBICO' }]);
    expect(r.notes).toEqual(['postura withdraw in TIRRENO: nessuna unità schierata da ritirare']);
  });

  it('budget: le unità che partono dalla base costano, oltre il budget non si impiegano', () => {
    const units = unitsOf('ITA'); // fregate 1,2–1,5 M€ a turno
    const r = translateStances({ ...base, budget: 2, units, stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 3 }] });
    const fromBase = idsOf(r.orders[0] as never).filter((id) => sc.world.units[id]!.status === 'ready');
    // 2 M€: una fregata (1,5), il drone (0,1) e un gruppo caccia (0,25) dalla base; i sottomarini (0,8) non ci stanno più;
    // il resto è già schierato (gratis)
    expect(fromBase).toEqual(['ITA-F593', 'ITA-MQ9', 'ITA-36ST']);
    expect(fromBase.reduce((a, id) => a + sc.world.units[id]!.opCostPerTurn, 0)).toBeLessThanOrEqual(2);
    const none = translateStances({ ...base, budget: 0.2, units: unitsOf('TUN'), stances: [{ zoneId: 'CANALE_SICILIA', stance: 'patrol', intensity: 1 }] });
    expect(none.orders).toEqual([]); // OPV da 0,3 M€ a turno, budget 0,2
    expect(none.notes).toEqual(['postura patrol in CANALE_SICILIA: budget insufficiente']);
    // le unità già schierate non costano
    const deployed = translateStances({ ...base, budget: 0, units, stances: [{ zoneId: 'MAR_ROSSO', stance: 'patrol', intensity: 1 }] });
    expect(idsOf(deployed.orders[0] as never)).toEqual(['ITA-F595']);
  });

  it('zona inesistente scartata; unità logorate e danneggiate rientrano comunque', () => {
    const units = unitsOf('ITA');
    Object.assign(units.find((u) => u.id === 'ITA-P431')!, { readiness: 30 });
    Object.assign(units.find((u) => u.id === 'ITA-D553')!, { status: 'damaged', damage: 20 } satisfies Partial<Unit>);
    const r = translateStances({ ...base, units, stances: [{ zoneId: 'ATLANTIDE', stance: 'patrol', intensity: 2 }] });
    expect(r.notes).toEqual(['postura patrol in ATLANTIDE: zona sconosciuta']);
    expect(r.orders).toEqual([{ id: 'stance-1', kind: 'RETURN_TO_BASE', unitIds: ['ITA-P431'] }, { id: 'stance-2', kind: 'REPAIR', unitIds: ['ITA-D553'] }]);
    expect(r.origins.every((o) => o.stance === 'worn')).toBe(true);
  });

  it('deterministico: stesso input → stessi ordini, a prescindere dall\'ordine delle unità', () => {
    const stances = [{ zoneId: 'EGEO', stance: 'show_of_force', intensity: 3 }, { zoneId: 'IONIO', stance: 'patrol', intensity: 2 }] as const;
    const a = translateStances({ ...base, units: unitsOf('ITA'), stances: [...stances] });
    const b = translateStances({ ...base, units: unitsOf('ITA').reverse(), stances: [...stances] });
    expect(b).toEqual(a);
  });

  it('conteggi per zona di mare per il prompt', () => {
    const f = stanceForces(unitsOf('TUN'), zones);
    expect(f.CANALE_SICILIA).toBe(2);
    expect(f.LIBIA_TERRA).toBeUndefined();
  });
});

describe('posture per zona: unità nominate dal giocatore (prefer)', () => {
  const patrolCS = [{ zoneId: 'CANALE_SICILIA', stance: 'patrol', intensity: 1 }] as const;

  it('«Bergamini» + postura patrol nel Canale di Sicilia → PATROL con ITA-F590 (senza prefer: la nave più vicina)', () => {
    const units = unitsOf('ITA');
    expect(translateStances({ ...base, units, stances: [...patrolCS] }).orders).toEqual([{ id: 'stance-1', kind: 'PATROL', unitIds: ['ITA-F593'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' }]);
    const r = translateStances({ ...base, units, stances: [...patrolCS], prefer: ['ITA-F590'] });
    expect(r.orders).toEqual([{ id: 'stance-1', kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' }]);
    expect(r.notes).toEqual([]);
  });

  it('«Cavour» + show_of_force intensità 2 nello Ionio → la Cavour c\'è e conta nell\'intensità', () => {
    const stances = [{ zoneId: 'IONIO', stance: 'show_of_force', intensity: 2 }] as const;
    expect(idsOf(translateStances({ ...base, units: unitsOf('ITA'), stances: [...stances] }).orders[0] as never)).not.toContain('ITA-CAVOUR');
    const ids = idsOf(translateStances({ ...base, units: unitsOf('ITA'), stances: [...stances], prefer: ['ITA-CAVOUR'] }).orders[0] as never);
    expect(ids[0]).toBe('ITA-CAVOUR');
    expect(ids).toHaveLength(3);
  });

  it('il sottomarino nominato entra anche dove gli scaglioni (POOLS) non lo metterebbero, e anche se impegnato altrove', () => {
    const units = unitsOf('ITA');
    // presence: gli scaglioni non hanno sottomarini
    const presence = translateStances({ ...base, units, stances: [{ zoneId: 'IONIO', stance: 'presence', intensity: 1 }], prefer: ['ITA-S526'] });
    expect(presence.orders).toEqual([{ id: 'stance-1', kind: 'PRESENCE', unitIds: ['ITA-S526'], zoneId: 'IONIO', roe: 'WEAPONS_HOLD' }]);
    // patrol intensità 1: senza prefer andrebbe una fregata
    expect(idsOf(translateStances({ ...base, units, stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 1 }] }).orders[0] as never)).not.toContain('ITA-S526');
    expect(idsOf(translateStances({ ...base, units, stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 1 }], prefer: ['ITA-S526'] }).orders[0] as never)).toEqual(['ITA-S526']);
    // impegnata in un compito nel Mar Rosso (busyElsewhere): nominata, va lo stesso
    Object.assign(units.find((u) => u.id === 'ITA-F595')!, { currentTask: { kind: 'PATROL', zoneId: 'MAR_ROSSO' } });
    const busy = translateStances({ ...base, units, stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 3 }] });
    expect(idsOf(busy.orders[0] as never)).not.toContain('ITA-F595');
    expect(idsOf(translateStances({ ...base, units, stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 1 }], prefer: ['ITA-F595'] }).orders[0] as never)).toEqual(['ITA-F595']);
  });

  it('più posture: ogni unità nominata va in quella della zona più vicina; con una postura sola vanno tutte lì', () => {
    const units = unitsOf('ITA');
    const two = translateStances({ ...base, units, prefer: ['ITA-S526', 'ITA-F590'],
      stances: [{ zoneId: 'IONIO', stance: 'patrol', intensity: 1 }, { zoneId: 'TIRRENO', stance: 'patrol', intensity: 1 }] });
    expect(two.orders.map((o) => [('zoneId' in o ? o.zoneId : null), idsOf(o as never)])).toEqual([['IONIO', ['ITA-S526']], ['TIRRENO', ['ITA-F590']]]);
    // una postura sola, intensità 1, tre unità nominate: entrano tutte
    const one = translateStances({ ...base, units, stances: [...patrolCS], prefer: ['ITA-F590', 'ITA-F591', 'ITA-F592'] });
    expect(idsOf(one.orders[0] as never)).toEqual(['ITA-F590', 'ITA-F591', 'ITA-F592']);
  });

  it('un\'unità nominata non adatta non entra: danneggiata, prontezza bassa, nave in zona terrestre, budget', () => {
    const units = unitsOf('ITA');
    Object.assign(units.find((u) => u.id === 'ITA-F590')!, { status: 'damaged', damage: 30 } satisfies Partial<Unit>);
    Object.assign(units.find((u) => u.id === 'ITA-F591')!, { readiness: 45 });
    const r = translateStances({ ...base, units, stances: [...patrolCS], prefer: ['ITA-F590', 'ITA-F591'] });
    expect(r.orders[0]).toEqual({ id: 'stance-1', kind: 'REPAIR', unitIds: ['ITA-F590'] });
    expect(idsOf(r.orders[1] as never)).toEqual(['ITA-F593']);
    expect(r.notes).toEqual(['unità nominata ITA-F590: danneggiata, va in riparazione', 'unità nominata ITA-F591: prontezza 45 sotto 50']);
    const land = translateStances({ ...base, units: unitsOf('ITA'), stances: [{ zoneId: 'LIBIA_TERRA', stance: 'presence', intensity: 1 }], prefer: ['ITA-F592'] });
    expect(land.orders.flatMap((o) => idsOf(o as never))).not.toContain('ITA-F592');
    expect(land.notes).toContain('unità nominata ITA-F592: unità navale, LIBIA_TERRA è una zona terrestre');
    const poor = translateStances({ ...base, budget: 1, units: unitsOf('ITA'), stances: [...patrolCS], prefer: ['ITA-F590'] }); // fregata 1,5 M€
    expect(poor.orders.flatMap((o) => idsOf(o as never))).not.toContain('ITA-F590');
    expect(poor.notes).toContain('unità nominata ITA-F590: budget insufficiente');
  });

  it('withdraw: prima le unità nominate fuori base, poi quelle schierate nella zona', () => {
    const r = translateStances({ ...base, units: unitsOf('ITA'), stances: [{ zoneId: 'MAR_ROSSO', stance: 'withdraw', intensity: 1 }], prefer: ['ITA-P431'] });
    expect(r.orders).toEqual([{ id: 'stance-1', kind: 'RETURN_TO_BASE', unitIds: ['ITA-P431', 'ITA-F595'] }]);
  });

  it('senza prefer (fazioni IA) il risultato non cambia', () => {
    const units = unitsOf('ITA');
    Object.assign(units.find((u) => u.id === 'ITA-F595')!, { currentTask: { kind: 'PATROL', zoneId: 'MAR_ROSSO' } });
    const stances = [{ zoneId: 'EGEO', stance: 'show_of_force', intensity: 3 }, { zoneId: 'IONIO', stance: 'patrol', intensity: 2 }, { zoneId: 'MAR_ROSSO', stance: 'withdraw', intensity: 1 }, { zoneId: 'LIBIA_TERRA', stance: 'presence', intensity: 1 }] as const;
    const without = translateStances({ ...base, units, stances: [...stances], exclude: ['ITA-F590'] });
    expect(translateStances({ ...base, units, stances: [...stances], exclude: ['ITA-F590'], prefer: [] })).toEqual(without);
    // nominata ma già in un ordine esplicito (exclude): nessun effetto
    expect(translateStances({ ...base, units, stances: [...stances], exclude: ['ITA-F590'], prefer: ['ITA-F590'] })).toEqual(without);
  });
});

describe('posture per zona in una decisione IA', () => {
  it('le posture diventano ordini validati, registrati con la loro origine ed eseguiti dal motore', async () => {
    const mock = new MockLLMProvider();
    // TUR risponde come un modello piccolo: posture + un ordine preciso a TUR-FF2 + una postura in una zona inventata
    const provider: LlmProvider = { name: 'fisso', complete: async (req) => {
      if (req.role !== 'faction_major' || req.meta.factionId !== 'TUR') return mock.complete(req);
      const text = JSON.stringify({
        situationAssessment: 'Egeo teso.', privateIntent: 'Mostrare i muscoli senza sparare.',
        zoneStances: [{ zoneId: 'EGEO', stance: 'show_of_force', intensity: 2 }, { zoneId: 'ATLANTIDE', stance: 'patrol', intensity: 1 }, { zoneId: 'EGEO', stance: 'dance', intensity: 1 }],
        orders: { military: [{ id: 'x', kind: 'PATROL', unitIds: ['TUR-FF2'], zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' }] }, confidence: 0.5,
      });
      return { text, usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'fisso' };
    } };
    const e = makeEngine(provider);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 's', seed: 'stances' });
    await e.advance(c.id);
    const d = (await e.store.getDecision(c.id, 1, 'TUR'))!;
    expect(d.validation).toMatchObject({ valid: true, fallbackUsed: false });
    expect(d.zoneStances).toEqual([{ zoneId: 'EGEO', stance: 'show_of_force', intensity: 2 }, { zoneId: 'ATLANTIDE', stance: 'patrol', intensity: 1 }]);
    const [explicit, sof] = d.orders.military;
    expect(explicit).toMatchObject({ kind: 'PATROL', unitIds: ['TUR-FF2'] });
    expect(sof).toMatchObject({ kind: 'SHOW_OF_FORCE', zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' });
    const ids = (sof as { unitIds: string[] }).unitIds;
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('TUR-FF2');
    expect(d.stanceOrders).toEqual([{ orderId: sof!.id, stance: 'show_of_force', zoneId: 'EGEO' }]);
    expect(d.validation.errors).toContain('postura — postura patrol in ATLANTIDE: zona sconosciuta');
    // il motore le ha eseguite come ordini normali
    const s = await e.store.getState(c.id, 1);
    for (const id of ids) expect(s.units[id]!.currentTask).toMatchObject({ kind: 'SHOW_OF_FORCE', zoneId: 'EGEO' });
  }, 30_000);
});
