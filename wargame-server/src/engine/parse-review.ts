import type { FactionKnowledge, Order, OrdersBody, Stance, Unit, WorldState, Zone, ZoneStance } from '../schemas/index.js';
import { buildLexicon, recognize, type NameHit } from './names.js';
import { PARAMS } from './params.js';
import { hashString } from './rng.js';
import type { Scenario } from './scenario.js';
import { stanceOrder, translateStances, unfitReason } from './stances.js';
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
 * Le unità nominate nel testo e non usate da un ordine esplicito vanno per prime nelle posture (`prefer`): i modelli
 * piccoli rispondono «CANALE_SICILIA patrol» invece di un ordine alla Bergamini, e senza `prefer` il motore sceglierebbe
 * la nave più vicina al posto di quella nominata.
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
  const recognized = i.parsed.recognized ?? recognize(i.text, buildLexicon(k.ownUnits, i.scenario)).hits;
  const explicit = orders.military.flatMap((o) => ('unitIds' in o ? o.unitIds : []));
  const prefer = [...new Set(recognized.filter((h) => h.kind === 'unit').map((h) => h.id))].filter((u) => !explicit.includes(u));
  const spent = validateOrders(s, i.scenario.catalog, factionId, orders, refs, i.turnLength).estCost;
  const t = translateStances({
    units: k.ownUnits, zones: i.scenario.world.zones, stances: i.parsed.zoneStances, turnLength: i.turnLength,
    exclude: explicit, prefer, budget: k.ownFaction.budget.discretionary - spent,
  });
  const stanceOrders = t.orders.map((o, j) => { const oid = id(); orders.military.push({ ...o, id: oid }); return { orderId: oid, ...t.origins[j]! }; });
  // il modello non ha dato né un ordine né una postura per le unità nominate: il motore completa la bozza (poi validata come le altre)
  const done = completeNamed({ text: i.text, recognized, orders, units: k.ownUnits, zones: i.scenario.world.zones, noted: t.notes });
  for (const o of done.orders) orders.military.push({ ...o, id: id() });
  const v = validateOrders(s, i.scenario.catalog, factionId, orders, refs, i.turnLength);
  // rientri dei logorati e riparazioni dei danneggiati: il motore li aggiunge comunque, non impiegano le unità nominate
  const auto = new Set(stanceOrders.filter((x) => x.stance === 'worn').map((x) => x.orderId));
  const review = reviewParsed({ text: i.text, orders, state: s, factionId, knowledge: k, recognized, auto });
  return {
    orders, zoneStances: i.parsed.zoneStances, recognized, stanceOrders,
    // avvisi, non errori: la bozza resta modificabile; gli errori veri (es. destinatario che non è una fazione) li dà il validatore
    validation: { ...v, risks: [...review.risks, ...v.risks] },
    ambiguities: [...i.parsed.ambiguities, ...t.notes.map((x) => `postura — ${x}`), ...done.notes, ...review.ambiguities],
  };
}

/** minuscolo e senza accenti, per cercare i verbi nel testo */
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** verbi di movimento o presenza di forze */
const MOVE_VERBS = /\b(pattugli\w*|port(a|are|ate|ino|i)|mand(a|are|ate|ino|i)|schier\w*|invi(a|are|ate|ino|i)|dispieg\w*|spost(a|are|ate|ino|i)|dimostrazione di forza|presenza|rischier\w*|rientr\w*|scort\w*|vad(a|ano))\b/;
/** tipo dell'ordine che il motore completa, dal verbo (il primo che corrisponde; altrimenti presenza) */
const COMPLETE_STANCE: [RegExp, Stance][] = [[/\brientr\w*/, 'withdraw'], [/dimostrazione di forza/, 'show_of_force'], [/\bpattugli\w*/, 'patrol'], [/\bscort\w*/, 'escort_shipping']];
/** negazioni: «non mandare la Bergamini» non si completa (resta l'ambiguità) */
const NEGATION = /\b(non|mai)\b/;

export interface CompleteInput { text: string; recognized: NameHit[]; orders: OrdersBody; units: Unit[]; zones: Record<string, Zone>; /** note del traduttore delle posture (unità già spiegate) */ noted?: string[] }

/**
 * Completamento deterministico della bozza: testo con un verbo di movimento o presenza (`MOVE_VERBS`), unità nominate e
 * una sola zona nominata, e unità che dopo le posture nessun ordine impiega → un ordine del motore per quelle unità in
 * quella zona. Tipo dal verbo («pattuglia» → PATROL, «dimostrazione di forza» → SHOW_OF_FORCE, «scorta» → ESCORT,
 * «rientra/rientrare» → RETURN_TO_BASE, altrimenti PRESENCE), ROE come nelle posture (`stanceOrder`). Solo le unità adatte
 * (`unfitReason`). Il rientro alla base vale anche senza zona nominata. L'ordine passa poi dal validatore come gli altri.
 */
export function completeNamed(i: CompleteInput): { orders: Order[]; notes: string[] } {
  const text = plain(i.text);
  if (!MOVE_VERBS.test(text) || NEGATION.test(text)) return { orders: [], notes: [] };
  const stance = COMPLETE_STANCE.find(([re]) => re.test(text))?.[1] ?? 'presence';
  const zoneIds = [...new Set(i.recognized.filter((h) => h.kind === 'zone').map((h) => h.id))];
  const zone = zoneIds.length === 1 ? i.zones[zoneIds[0]!] ?? null : null;
  if (!zone && !(stance === 'withdraw' && !zoneIds.length)) return { orders: [], notes: [] };
  const busy = new Set(i.orders.military.flatMap((o) => ('unitIds' in o ? o.unitIds : [])));
  const notes: string[] = []; const ids: string[] = [];
  for (const id of new Set(i.recognized.filter((h) => h.kind === 'unit').map((h) => h.id))) {
    const u = i.units.find((x) => x.id === id);
    if (!u || busy.has(id)) continue;
    const why = unfitReason(u, zone, stance);
    if (!why) ids.push(id);
    else if (!i.noted?.some((n) => n.includes(id))) notes.push(`${id} non impiegabile: ${why}.`);
  }
  if (!ids.length) return { orders: [], notes };
  const order = stance === 'withdraw' ? { id: '', kind: 'RETURN_TO_BASE' as const, unitIds: ids } : stanceOrder(stance, ids, zone!.id);
  notes.push(`Ordine completato dal motore: ${order.kind} per ${ids.join(', ')}${zone && stance !== 'withdraw' ? ` in ${zone.id}` : ''} (il modello non ha dato né un ordine né una postura per ${ids.length > 1 ? 'queste unità' : 'questa unità'}): controlla che sia quello che volevi.`);
  return { orders: [order], notes };
}
/** parole che dicono che si parla di forze militari, anche senza un nome riconosciuto */
const FORCE_WORDS = /\b(nav[ei]|fregat[ae]|unita|sottomarin[oi]|portaerei|cacciatorpedinier[ei]|pattugliator[ei]|aere[oi]|caccia|stormo|droni?|squadra navale|flotta)\b/;
const CYBER_WORDS = /(cyber|ciber|hack|informatic|malware|intrusion[ei] (nei|nelle) (reti|sistemi)|attacco (alle|alla) ret[ei])/;
/** verbo diplomatico → tipi di azione che lo soddisfano */
const DIPLO_VERBS: [RegExp, string[], string][] = [
  [/\brassicur\w*/, ['REASSURANCE', 'BACKCHANNEL', 'LETTER'], 'rassicurare'],
  [/\bminacc\w*/, ['THREAT', 'SANCTION', 'LETTER'], 'minacciare'],
  [/\bsanzion\w*/, ['SANCTION', 'THREAT'], 'sanzionare'],
  [/\b(chied\w*|chiedi|sollecit\w*|protest\w*)/, ['DEMARCHE', 'BACKCHANNEL', 'PROPOSE_AGREEMENT', 'LETTER', 'THREAT'], 'chiedere o protestare'],
];

export interface ReviewInput {
  text: string; orders: OrdersBody; state: WorldState; factionId: string; knowledge: FactionKnowledge; recognized: NameHit[];
  /** ordini aggiunti dal motore a prescindere dalla direttiva (rientro dei logorati, riparazioni): non impiegano le unità */
  auto?: Set<string>;
}

/** Un alleato: stessa alleanza (NATO, UE), il blocco di cui si fa parte, o fiducia ≥ soglia. Restituisce il motivo o null. */
export function allyReason(s: WorldState, me: string, other: string): string | null {
  const a = s.factions[me]; const b = s.factions[other];
  if (!a || !b || me === other) return null;
  const shared = a.alliances.filter((x) => b.alliances.includes(x) || x === other);
  if (shared.length) return shared.join(', ');
  const trust = s.relations[me]?.[other]?.trust ?? 0;
  return trust >= PARAMS.parser.allyTrust ? `fiducia ${trust}` : null;
}

/**
 * Controlli dopo l'LLM sulla bozza di una direttiva (avvisi e ambiguità, non errori): movimento senza unità, azioni
 * ostili verso alleati, operazioni cyber non richieste, verbi diplomatici senza l'azione corrispondente.
 */
export function reviewParsed(i: ReviewInput): { risks: string[]; ambiguities: string[] } {
  const { state: s, factionId: me, orders } = i;
  const risks: string[] = []; const ambiguities: string[] = [];
  const text = plain(i.text);
  const name = (f: string) => `${s.factions[f]?.name ?? f} (${f})`;
  const withUnits = orders.military.filter((o) => 'unitIds' in o && o.unitIds.length && !i.auto?.has(o.id));
  const namedUnits = [...new Set(i.recognized.filter((h) => h.kind === 'unit').map((h) => h.id))];
  const namedZones = [...new Set(i.recognized.filter((h) => h.kind === 'zone').map((h) => h.id))];
  const namedFactions = [...new Set(i.recognized.filter((h) => h.kind === 'faction' && h.id !== me).map((h) => h.id))];

  // 1) movimento o presenza di forze → almeno un ordine con unità, nella zona nominata, con le unità nominate
  const verb = text.match(MOVE_VERBS)?.[0];
  if (verb && (namedUnits.length || namedZones.length || FORCE_WORDS.test(text))) {
    if (!withUnits.length) ambiguities.push(`La direttiva chiede di muovere forze («${verb}») ma nessun ordine assegna unità: indica la nave e la zona, oppure usa il costruttore.`);
    else {
      const zoneOf = (o: OrdersBody['military'][number]) => ('zoneId' in o ? o.zoneId : o.kind === 'MOVE' && typeof o.to === 'string' ? o.to : o.kind === 'ESCORT' ? o.protect.replace(/^convoglio\s*/i, '') : null);
      // un rientro alla base riguarda la zona da cui le unità rientrano («dal Mar Rosso»)
      const covers = (o: OrdersBody['military'][number], z: string) => zoneOf(o) === z || (o.kind === 'RETURN_TO_BASE' && o.unitIds.some((u) => s.units[u]?.zoneId === z));
      for (const z of namedZones) if (!withUnits.some((o) => covers(o, z))) ambiguities.push(`Nessun ordine porta forze in ${z}, nominata nella direttiva.`);
    }
    const assigned = new Set(withUnits.flatMap((o) => ('unitIds' in o ? o.unitIds : [])));
    for (const u of namedUnits) if (!assigned.has(u)) ambiguities.push(`${u} è nominata nella direttiva ma nessun ordine la impiega.`);
  }

  // 2) azioni ostili verso alleati (NATO/UE o fiducia ≥ 40): avviso chiaro
  const contactFaction = new Map(i.knowledge.contacts.map((c) => [c.id, c.estFaction]));
  const hostile: { kind: string; target: string }[] = [];
  for (const o of orders.military) {
    if (o.kind === 'CYBER_OP' && o.effect === 'disruption') hostile.push({ kind: 'CYBER_OP (disruption)', target: o.target });
    if (o.kind === 'STRIKE') {
      const owners = [...(s.infrastructure[o.targetRef]?.owners ?? []), s.bases[o.targetRef]?.factionId, contactFaction.get(o.targetRef)].filter((x): x is string => !!x);
      for (const f of new Set(owners)) hostile.push({ kind: 'STRIKE', target: f });
    }
    if (o.kind === 'BLOCKADE') {
      const present = [...Object.values(s.bases).filter((b) => b.zoneId === o.zoneId).map((b) => b.factionId), ...Object.values(s.infrastructure).filter((x) => x.zoneId === o.zoneId).flatMap((x) => x.owners)];
      for (const f of new Set(present)) hostile.push({ kind: `BLOCKADE in ${o.zoneId}`, target: f });
    }
  }
  for (const d of orders.diplomacy) if ((d.kind === 'THREAT' || d.kind === 'SANCTION') && typeof d.target === 'string') hostile.push({ kind: d.kind, target: d.target });
  const warned = new Set<string>();
  for (const h of hostile) {
    const why = allyReason(s, me, h.target);
    const key = `${h.kind}|${h.target}`;
    if (!why || warned.has(key)) continue;
    warned.add(key);
    risks.push(`⚠ ${h.kind} contro ${name(h.target)}, alleato (${why}): azione ostile verso un alleato, verifica che sia davvero voluta.`);
  }

  // 3) operazioni cyber che il testo non chiede
  if (!CYBER_WORDS.test(text)) for (const o of orders.military) if (o.kind === 'CYBER_OP')
    risks.push(`⚠ ${o.id}: CYBER_OP contro ${o.target} non richiesta, la direttiva non parla di cyber o operazioni informatiche: probabile errore di interpretazione, toglila.`);

  // 4) verbi diplomatici → l'azione corrispondente, verso i paesi nominati
  for (const [re, kinds, label] of DIPLO_VERBS) {
    if (!re.test(text)) continue;
    const acts = orders.diplomacy.filter((d) => kinds.includes(d.kind));
    if (!acts.length && namedFactions.length) ambiguities.push(`La direttiva chiede di ${label} ma nella bozza non c'è un'azione ${kinds[0]}.`);
  }
  if (DIPLO_VERBS.some(([re]) => re.test(text))) {
    const targeted = new Set(orders.diplomacy.flatMap((d) => ('target' in d ? (Array.isArray(d.target) ? d.target : [d.target]) : [])));
    for (const f of namedFactions) if (s.factions[f]?.kind !== 'bloc' && !targeted.has(f)) ambiguities.push(`${name(f)} è nominata nella direttiva ma nessuna azione diplomatica la riguarda.`);
  }
  return { risks, ambiguities };
}
