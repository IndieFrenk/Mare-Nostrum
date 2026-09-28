import { describe, expect, it } from 'vitest';
import type { Unit } from '../src/schemas/index.js';
import { loadScenario } from '../src/engine/scenario.js';
import { stanceForces, translateStances } from '../src/engine/stances.js';

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
    // 2 M€: una fregata (1,5) e il drone (0,1) dalla base; i sottomarini (0,8) non ci stanno più; il resto è già schierato (gratis)
    expect(fromBase).toEqual(['ITA-F593', 'ITA-MQ9']);
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
