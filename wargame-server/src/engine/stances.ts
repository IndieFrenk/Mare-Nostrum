import type { Order, Stance, Unit, UnitType, Zone, ZoneStance } from '../schemas/index.js';
import { distanceKm } from './geo.js';
import { PARAMS } from './params.js';

/**
 * Traduttore deterministico delle posture per zona: l'IA sceglie zona, postura e intensità, qui si scelgono le unità.
 * Funzione pura: stesso input → stessi ordini (nessuna casualità, ordinamenti stabili), così il replay resta identico.
 */

/** Tipi di unità adatti a ogni postura, a scaglioni: si pesca dal primo scaglione, poi dal successivo. */
const POOLS: Record<Exclude<Stance, 'withdraw'>, { sea: UnitType[][]; land: UnitType[][] | null }> = {
  patrol: { sea: [['frigate', 'opv', 'destroyer', 'submarine'], ['mpa', 'drone_flight', 'aew', 'fighter_sqn']], land: [['drone_flight', 'mpa', 'aew', 'fighter_sqn'], ['ground_bn']] },
  presence: { sea: [['frigate', 'opv', 'destroyer', 'lhd', 'carrier']], land: [['ground_bn'], ['fighter_sqn', 'drone_flight']] },
  show_of_force: { sea: [['carrier', 'lhd', 'destroyer', 'frigate'], ['fighter_sqn', 'strike_sqn', 'opv']], land: [['fighter_sqn', 'strike_sqn'], ['ground_bn']] },
  escort_shipping: { sea: [['frigate', 'destroyer', 'opv']], land: null },
  blockade: { sea: [['destroyer', 'frigate', 'opv'], ['submarine']], land: null },
  air_defense: { sea: [['sam_battery'], ['destroyer', 'frigate', 'fighter_sqn']], land: [['sam_battery'], ['fighter_sqn']] },
};
const ORDER: Record<Exclude<Stance, 'withdraw' | 'escort_shipping' | 'air_defense'>, { kind: 'PATROL' | 'PRESENCE' | 'SHOW_OF_FORCE' | 'BLOCKADE'; roe: 'WEAPONS_HOLD' | 'WEAPONS_TIGHT' }> = {
  patrol: { kind: 'PATROL', roe: 'WEAPONS_TIGHT' }, presence: { kind: 'PRESENCE', roe: 'WEAPONS_HOLD' },
  show_of_force: { kind: 'SHOW_OF_FORCE', roe: 'WEAPONS_TIGHT' }, blockade: { kind: 'BLOCKADE', roe: 'WEAPONS_TIGHT' },
};

export interface StanceInput {
  /** unità della fazione (le proprie: nessun dato nascosto) */
  units: Unit[];
  zones: Record<string, Zone>;
  stances: ZoneStance[];
  /** unità già usate da ordini espliciti della stessa decisione */
  exclude?: Iterable<string>;
  /** M€ ancora spendibili (budget meno il costo degli ordini espliciti) */
  budget: number;
  turnLength: 'week' | 'month';
}
export interface StanceOrigin { stance: Stance | 'worn'; zoneId: string | null }
export interface StanceResult { orders: Order[]; origins: StanceOrigin[]; notes: string[] }

const byId = (a: Unit, b: Unit) => a.id.localeCompare(b.id);
/** unità schierate ma impegnate altrove: non si distolgono (lo può fare solo un ordine esplicito) */
const busyElsewhere = (u: Unit, zoneId: string) => u.status === 'deployed' && !!u.currentTask && u.zoneId !== zoneId;

/** Unità candidate per una postura in una zona, nell'ordine in cui il motore le sceglie. */
export function candidates(units: Unit[], zone: Zone, stance: Exclude<Stance, 'withdraw'>, used: Set<string>): Unit[] {
  const tiers = POOLS[stance][zone.terrain === 'land' ? 'land' : 'sea'];
  if (!tiers) return [];
  const ok = (u: Unit) => !used.has(u.id) && (u.status === 'ready' || u.status === 'deployed') && u.readiness >= PARAMS.stances.minReadiness && !busyElsewhere(u, zone.id)
    // le navi non vanno nelle zone terrestri (stessa regola del validatore)
    && !(zone.terrain === 'land' && (u.domain === 'sea' || u.domain === 'subsurface'));
  const rank = (u: Unit) => [u.zoneId === zone.id ? 0 : 1, Math.round(distanceKm(u.location, zone.center))] as const;
  return tiers.flatMap((types) => units.filter((u) => types.includes(u.type) && ok(u)).sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || byId(a, b);
  }));
}

/** Posture → ordini militari. Le posture impossibili (zona inesistente, postura non adatta, nessuna unità) finiscono in `notes`. */
export function translateStances(i: StanceInput): StanceResult {
  const orders: Order[] = []; const origins: StanceOrigin[] = []; const notes: string[] = [];
  const used = new Set(i.exclude ?? []);
  const units = [...i.units].filter((u) => u.status !== 'destroyed').sort(byId);
  const mult = PARAMS.opCostMultiplier[i.turnLength];
  let budget = i.budget;
  let n = 0;
  const push = (o: Order, origin: StanceOrigin) => { orders.push({ ...o, id: `stance-${++n}` }); origins.push(origin); };

  // 1) unità logorate o danneggiate: rientro o riparazione comunque, come nella dottrina (prima delle posture: non si reimpiegano)
  const worn = units.filter((u) => !used.has(u.id) && (u.status === 'deployed' || u.status === 'transit') && u.readiness < PARAMS.stances.wornReadiness);
  const damaged = units.filter((u) => !used.has(u.id) && u.status === 'damaged');
  if (worn.length) { push({ id: '', kind: 'RETURN_TO_BASE', unitIds: worn.map((u) => u.id) }, { stance: 'worn', zoneId: null }); worn.forEach((u) => used.add(u.id)); }
  if (damaged.length) { push({ id: '', kind: 'REPAIR', unitIds: damaged.map((u) => u.id) }, { stance: 'worn', zoneId: null }); damaged.forEach((u) => used.add(u.id)); }

  // 2) posture, nell'ordine in cui le ha date la fazione
  for (const st of i.stances) {
    const zone = i.zones[st.zoneId];
    const label = `postura ${st.stance} in ${st.zoneId}`;
    if (!zone) { notes.push(`${label}: zona sconosciuta`); continue; }
    if (st.stance === 'withdraw') {
      const out = units.filter((u) => !used.has(u.id) && u.zoneId === zone.id && (u.status === 'deployed' || u.status === 'transit'));
      if (!out.length) { notes.push(`${label}: nessuna unità schierata da ritirare`); continue; }
      push({ id: '', kind: 'RETURN_TO_BASE', unitIds: out.map((u) => u.id) }, { stance: 'withdraw', zoneId: zone.id });
      out.forEach((u) => used.add(u.id));
      continue;
    }
    if (!POOLS[st.stance][zone.terrain === 'land' ? 'land' : 'sea']) { notes.push(`${label}: postura possibile solo in zone di mare`); continue; }
    const want = PARAMS.stances.unitsByIntensity[Math.max(1, Math.min(3, Math.round(st.intensity)))]!;
    const picked: Unit[] = []; let tooExpensive = 0;
    for (const u of candidates(units, zone, st.stance, used)) {
      if (picked.length >= want) break;
      // solo le unità che partono dalla base costano (stessa regola del validatore)
      const cost = u.status === 'ready' ? u.opCostPerTurn * mult : 0;
      if (cost > budget) { tooExpensive++; continue; }
      budget -= cost; picked.push(u);
    }
    if (!picked.length) { notes.push(`${label}: ${tooExpensive ? 'budget insufficiente' : 'nessuna unità adatta disponibile'}`); continue; }
    const unitIds = picked.map((u) => u.id);
    picked.forEach((u) => used.add(u.id));
    const origin = { stance: st.stance, zoneId: zone.id };
    if (st.stance === 'escort_shipping') push({ id: '', kind: 'ESCORT', unitIds, protect: `convoglio ${zone.id}`, roe: 'WEAPONS_TIGHT' }, origin);
    else if (st.stance === 'air_defense') push({ id: '', kind: 'AIR_DEFENSE', unitIds, zoneId: zone.id, alert: 'high' }, origin);
    else push({ id: '', kind: ORDER[st.stance].kind, unitIds, zoneId: zone.id, roe: ORDER[st.stance].roe }, origin);
    if (picked.length < want) notes.push(`${label}: ${picked.length} unità su ${want} richieste`);
  }
  return { orders, origins, notes };
}

/** Per il prompt: quante unità la fazione può impiegare in ogni zona di mare con una postura (conteggi, non id). */
export function stanceForces(units: Unit[], zones: Record<string, Zone>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const z of Object.values(zones).filter((x) => x.terrain !== 'land').sort((a, b) => a.id.localeCompare(b.id))) {
    const n = new Set((['patrol', 'show_of_force', 'air_defense'] as const).flatMap((s) => candidates(units, z, s, new Set()).map((u) => u.id))).size;
    if (n) out[z.id] = n;
  }
  return out;
}
