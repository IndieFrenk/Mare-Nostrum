import type { FactionKnowledge, OrdersBody, WorldState, ZoneStance } from '../schemas/index.js';
import type { NameHit } from './names.js';
import { hashString } from './rng.js';
import type { Scenario } from './scenario.js';
import { translateStances } from './stances.js';
import { validateOrders, type Validation } from './validators.js';

/** Bozza proposta dal parser (LLM) per una direttiva del giocatore, prima dei controlli del motore. */
export interface ParsedDirective { orders: OrdersBody; zoneStances: ZoneStance[]; ambiguities: string[]; recognized?: NameHit[] }
export interface ParsedDraft {
  orders: OrdersBody; zoneStances: ZoneStance[]; ambiguities: string[]; recognized: NameHit[];
  /** quale ordine militare viene da quale postura per zona (unità scelte dal motore) */
  stanceOrders: { orderId: string; stance: string; zoneId: string | null }[];
  validation: Validation;
}
export interface FinishInput {
  state: WorldState; scenario: Scenario; factionId: string; knowledge: FactionKnowledge; turnLength: 'week' | 'month';
  text: string; parsed: ParsedDirective;
}

/**
 * Completa la bozza del parser in modo deterministico: id univoci (la bozza si somma a quella del giocatore),
 * posture per zona tradotte in ordini con le unità scelte dal motore (engine/stances.ts), validazione.
 */
export function finishParsed(i: FinishInput): ParsedDraft {
  const { state: s, factionId, knowledge: k } = i;
  const refs = new Set(k.contacts.map((c) => c.id));
  const tag = `txt${k.turn}-${hashString(i.text).toString(36).slice(0, 5)}`;
  let n = 0;
  const id = () => `${tag}-${++n}`;
  const p = i.parsed.orders;
  const orders: OrdersBody = {
    military: p.military.map((x) => ({ ...x, id: id() })), diplomacy: p.diplomacy.map((x) => ({ ...x, id: id() })),
    procurement: p.procurement.map((x) => ({ ...x, id: id() })), statements: p.statements.map((x) => ({ ...x, id: id() })),
  };
  const spent = validateOrders(s, i.scenario.catalog, factionId, orders, refs, i.turnLength).estCost;
  const t = translateStances({
    units: k.ownUnits, zones: i.scenario.world.zones, stances: i.parsed.zoneStances, turnLength: i.turnLength,
    exclude: orders.military.flatMap((o) => ('unitIds' in o ? o.unitIds : [])), budget: k.ownFaction.budget.discretionary - spent,
  });
  const stanceOrders = t.orders.map((o, j) => { const oid = id(); orders.military.push({ ...o, id: oid }); return { orderId: oid, ...t.origins[j]! }; });
  const validation = validateOrders(s, i.scenario.catalog, factionId, orders, refs, i.turnLength);
  return {
    orders, zoneStances: i.parsed.zoneStances, recognized: i.parsed.recognized ?? [], stanceOrders, validation,
    ambiguities: [...i.parsed.ambiguities, ...t.notes.map((x) => `postura — ${x}`)],
  };
}
