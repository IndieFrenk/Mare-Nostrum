import type { Agreement, DiploAction, GameEvent, OpinionModifier, WorldState } from '../schemas/index.js';
import { OPINION_BANDS } from '../schemas/index.js';
import type { ActionRow, AgreementView, BandIndex, CountryView, DiplomacyOverview, ModifierView, ProposalRow, Reason, TensionBandView, UltimatumView, VoteView } from '../schemas/index.js';
import { acceptance, type AcceptanceReason, type AcceptanceResult, type Proposal } from './acceptance.js';
import { AGREEMENT_COST, DIPLO_CATALOG, actionCost, actionInfo, improveSlots, tieOf, weeklyRent, type DiploKind } from './diplo-actions.js';
import { baseOpinion, opinionBand, opinionLookup, opinionOf, tensionOf, weeksOfTurn } from './opinion.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Viste di sola lettura della diplomazia per l'interfaccia (docs/wargame/DIPLOMAZIA.md §12): panoramica, scheda di ogni Stato, votazioni.
 * Funzioni pure sul WorldState, **sempre dal punto di vista di una fazione** (`me`, il giocatore): la nebbia del §5.6 vale qui e non nell'interfaccia.
 * - la propria riga (l'opinione di `me` verso gli altri) è esatta, con i motivi;
 * - l'opinione degli altri verso `me` è una fascia; il numero esatto (e i motivi) solo con un accordo di intelligence attivo;
 * - le coppie tra terzi non compaiono mai (solo i trattati e i voti pubblici).
 */

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Le quattro fasce della tensione mondiale (§6). */
export const TENSION_BANDS: TensionBandView[] = [
  { index: 0, label: 'Distensione', from: 0, to: 24, effect: 'Le azioni coercitive delle democrazie costano il doppio di CD e danno −opinione con le altre democrazie' },
  { index: 1, label: 'Normale', from: 25, to: 49, effect: 'Nessun effetto particolare' },
  { index: 2, label: 'Alta', from: 50, to: 74, effect: 'Garanzie e alleanze più facili da accettare; sanzioni multilaterali più probabili' },
  { index: 3, label: 'Critica', from: 75, to: 100, effect: 'Tutti più difensivi; gli Stati si stringono ai propri blocchi; Brent, TTF e rischio navale salgono' },
];
export const tensionBand = (v: number): TensionBandView => TENSION_BANDS[v < 25 ? 0 : v < 50 ? 1 : v < 75 ? 2 : 3]!;

/** Indice della fascia d'opinione (0 ostile … 4 stretta). */
export const bandIndex = (value: number): BandIndex => OPINION_BANDS.indexOf(opinionBand(value)) as BandIndex;
/** Valore di mezzo di ogni fascia: la stima di un'opinione che si vede solo a fasce. */
const bandMid = (i: BandIndex): number => { const [t0, t1, t2, t3] = PARAMS.opinion.bands; return [t0 - 25, (t0 + t1) / 2, (t1 + t2) / 2, (t2 + t3) / 2, t3 + 25][i]!; };

// ——— nebbia ———

/** Gli attori con cui `me` ha un accordo di intelligence attivo: di loro vede l'opinione verso di sé esatta. */
export function intelPartners(s: WorldState, me: string): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(s.agreements)) if (a.status === 'active' && a.type === 'intel_sharing' && a.parties.includes(me)) for (const p of a.parties) if (p !== me) out.add(p);
  return out;
}
export const hasIntel = (s: WorldState, me: string, other: string) => intelPartners(s, me).has(other);

/** Gli attori con cui si può avere una diplomazia: le fazioni (blocchi esclusi) e gli Stati del registro senza fazione (ISO3). */
export function diploActors(s: WorldState): string[] {
  const w = worldData();
  return [...Object.values(s.factions).filter((f) => f.kind !== 'bloc').map((f) => f.id), ...w.nations.filter((n) => !n.factionId).map((n) => n.iso3)].sort();
}

/** I turni che mancano alla fine di un modificatore: `null` se non scade (permanente, o resta finché la causa è attiva). */
export function turnsLeft(m: OpinionModifier, turn: number, weeks: number): number | null {
  if (m.expiresTurn !== undefined) return Math.max(0, m.expiresTurn - turn);
  if (m.decayPerWeek <= 0 || m.floor !== undefined) return null;
  return Math.floor((Math.abs(m.value) - PARAMS.opinion.epsilon) / (m.decayPerWeek * weeks)) + 1;
}
const modifierView = (m: OpinionModifier, turn: number, weeks: number): ModifierView => ({ label: m.label, value: m.value, turnsLeft: turnsLeft(m, turn, weeks) });
const byWeight = (a: { value: number; label: string }, b: { value: number; label: string }) => Math.abs(b.value) - Math.abs(a.value) || a.label.localeCompare(b.label);

const agreementView = (a: Agreement): AgreementView => ({ id: a.id, type: a.type, parties: a.parties, status: a.status, startTurn: a.startTurn, endTurn: a.endTurn });
/** Un trattato lo vede `me` se è pubblico, se ne è parte o se è riservato a lei. */
const agreementVisible = (a: Agreement, me: string) => a.visibility === 'public' || a.parties.includes(me) || a.visibility.includes(me);

// ——— accettazione stimata ———

export type FoggedAcceptance = AcceptanceResult & { exact: boolean };

/**
 * `acceptance()` come la può vedere `me` (nebbia, §5.6): senza un accordo di intelligence con il destinatario l'opinione di lui verso `me`
 * è nota solo a fasce, quindi il motivo «Opinione verso il proponente» usa il valore di mezzo della fascia (una **stima**), e dei motivi
 * che nominano terzi (nemici in comune, trattati in vigore) restano il valore ma non i nomi: sarebbero coppie tra terzi.
 * Il motore (esecuzione delle proposte, IA mondiale) continua a usare `acceptance()` esatta.
 */
export function acceptanceFor(s: WorldState, me: string, target: string, proposal: Proposal): FoggedAcceptance {
  const real = acceptance(s, target, proposal, me);
  if (target === me || hasIntel(s, me, target)) return { ...real, exact: true };
  const band = bandIndex(opinionOf(s, target, me).value);
  const reasons: AcceptanceReason[] = real.reasons.map((r) => {
    if (r.label.startsWith('Opinione verso il proponente')) return { label: `Opinione verso il proponente (stima: ${OPINION_BANDS[band]})`, value: r1(bandMid(band) * PARAMS.acceptance.opinionWeight) };
    if (r.label.startsWith('Minaccia comune')) return { ...r, label: 'Minaccia comune (nemici in comune)' };
    if (r.label.startsWith('Conflitto con un trattato in vigore')) return { ...r, label: 'Conflitto con un trattato in vigore del destinatario' };
    if (r.label.startsWith('Tra le parti c\'è un rivale')) return { ...r, label: 'Tra le parti c\'è un rivale del destinatario' };
    return r;
  });
  const score = r1(reasons.reduce((n, r) => n + r.value, 0));
  return { target, score, accept: score >= 0, reasons, exact: false };
}

// ——— panoramica ———

export interface OverviewOpts { turnLength: 'week' | 'month'; /** l'ultimo evento WORLD_TENSION_CHANGED (pubblico) per le cause */ tensionEvent?: GameEvent | undefined }

/** Tensione mondiale con le cause dell'ultimo turno, CD e rendita, slot di «Migliorare le relazioni», ultimatum, opinione verso tutti e di tutti. */
export function diplomacyOverview(s: WorldState, me: string, o: OverviewOpts): DiplomacyOverview {
  const d = s.diplomacy;
  const lookup = opinionLookup(s);
  const intel = intelPartners(s, me);
  const out: Record<string, number> = {}; const inn: Record<string, BandIndex> = {}; const exact: Record<string, number> = {};
  for (const a of diploActors(s)) {
    if (a === me) continue;
    out[a] = lookup(me, a);
    const theirs = lookup(a, me);
    inn[a] = bandIndex(theirs);
    if (intel.has(a)) exact[a] = theirs;
  }
  const ev = o.tensionEvent?.payload as { from?: number; causes?: Reason[] } | undefined;
  const value = r1(s.globalIndicators.worldTension);
  const ultimatums: UltimatumView[] = (d?.ultimatums ?? [])
    .filter((u) => (u.from === me || u.to === me) && (u.status === 'pending' || (u.status === 'expired' && (u.legitimateUntil ?? 0) >= s.turn)))
    .sort((a, b) => a.deadlineTurn - b.deadlineTurn || a.id.localeCompare(b.id))
    .map((u) => ({ id: u.id, from: u.from, to: u.to, demand: u.demand, deadlineTurn: u.deadlineTurn, status: u.status, ...(u.legitimateUntil !== undefined ? { legitimateUntil: u.legitimateUntil } : {}), turnsLeft: u.status === 'pending' ? u.deadlineTurn - s.turn : u.legitimateUntil !== undefined ? u.legitimateUntil - s.turn : null }));
  return {
    turn: s.turn,
    capital: {
      value: r1(d?.capital[me] ?? 0), rent: weeklyRent(s, me), weeks: weeksOfTurn(o.turnLength), improvingSlots: improveSlots(s, me),
      improving: (d?.improving ?? []).filter((x) => x.actor === me).map((x) => ({ target: x.target, since: x.since })),
      coerciveCost: actionCost(s, me, { id: '', kind: 'SANCTION', target: me, scope: '' }) / (DIPLO_CATALOG.SANCTION.cost as number),
    },
    tension: { value, band: tensionBand(value), bands: TENSION_BANDS, from: typeof ev?.from === 'number' ? ev.from : null, causes: (ev?.causes ?? []).map((c) => ({ label: c.label, value: c.value })) },
    ultimatums,
    agreements: Object.values(s.agreements).filter((a) => a.parties.includes(me) && (a.status === 'active' || a.status === 'proposed')).sort((a, b) => a.id.localeCompare(b.id)).map(agreementView),
    opinion: { bands: OPINION_BANDS, thresholds: PARAMS.opinion.bands, out, in: inn, exact },
  };
}

// ——— scheda paese ———

/** Trattati che si possono proporre dalla scheda di uno Stato, con il nome da mostrare (il costo viene da `AGREEMENT_COST`). */
export const PROPOSABLE: [Agreement['type'], string][] = [
  ['non_aggression', 'Patto di non aggressione'], ['trade', 'Accordo commerciale'], ['migration', 'Accordo migratorio'], ['energy', 'Accordo energetico'],
  ['intel_sharing', 'Condivisione di intelligence'], ['defense_cooperation', 'Cooperazione di difesa'], ['guarantee', 'Garanzia di sicurezza'], ['defense', 'Alleanza difensiva'],
  ['military_access', 'Accesso militare'], ['basing', 'Basi'], ['arms_sale', 'Vendita di armi'],
];

/** Azioni verso un singolo Stato che non chiedono altri dati (importi, infrastrutture, testi): ENERGY_DEAL e AID restano nella Console Ordini. */
const COUNTRY_ACTIONS: DiploKind[] = ['IMPROVE_RELATIONS', 'STOP_IMPROVE', 'DEMARCHE', 'REASSURANCE', 'BACKCHANNEL', 'THREAT', 'SANCTION', 'LIFT_SANCTION', 'RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO', 'ULTIMATUM'];

/** Azione-campione verso `target` per leggere costo, ricarica e prerequisiti dal catalogo (non è un ordine: non si salva). */
function sampleAction(kind: DiploKind, target: string): DiploAction {
  const id = 'view';
  switch (kind) {
    case 'DEMARCHE': case 'THREAT': case 'REASSURANCE': return { id, kind, target, message: '', visibility: 'public' };
    case 'BACKCHANNEL': return { id, kind, target, message: '' };
    case 'SANCTION': case 'LIFT_SANCTION': return { id, kind, target, scope: '' };
    case 'ULTIMATUM': return { id, kind, target, demand: '', deadlineTurns: 2 };
    default: return { id, kind, target } as DiploAction;
  }
}

/**
 * La scheda diplomatica di uno Stato (`actor`: id di fazione o ISO3 di uno Stato senza fazione) vista da `me`. Null se non è un attore
 * (un blocco come NATO o UE non ha opinione né azioni). Dati statici (popolazione, PIL…) non ci sono: stanno in `/nations/:iso3`.
 */
export function countryView(s: WorldState, me: string, actor: string, turnLength: 'week' | 'month'): CountryView | null {
  const w = worldData();
  const f = s.factions[actor];
  if (f ? f.kind === 'bloc' : !(w.nation(actor) && !w.nation(actor)!.factionId)) return null;
  const iso3 = w.isoOf(actor);
  const n = iso3 ? w.nation(iso3) : undefined;
  const d = s.diplomacy;
  const weeks = weeksOfTurn(turnLength);
  const self = actor === me;
  const myIso = w.isoOf(me);
  const myMemberships = new Set(myIso ? w.nation(myIso)?.memberships ?? [] : []);
  const base: CountryView = {
    actor, ...(n ? { iso2: n.iso2, iso3: n.iso3 } : {}), name: n?.nameIt ?? f?.name ?? actor, isFaction: !!f, self,
    opinion: { out: { value: 0, band: 2, base: [], modifiers: [] }, in: { band: 2, known: [] } },
    tension: 0, ties: null, embargo: { toThem: false, toUs: false }, improving: null, agreements: [], memberships: [], actions: [], proposals: [],
  };
  base.memberships = (n?.memberships ?? []).map((id) => ({ id, nameIt: w.institution(id)?.nameIt ?? id, shared: myMemberships.has(id) }));
  const mine = Object.values(s.agreements).filter((a) => a.parties.includes(actor) && (self ? a.parties.includes(me) : (a.status === 'active' || a.status === 'violated' ? agreementVisible(a, me) : a.status === 'proposed' && a.parties.includes(me))));
  base.agreements = mine.sort((a, b) => Number(b.parties.includes(me)) - Number(a.parties.includes(me)) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id)).slice(0, 12)
    .map((a) => ({ ...agreementView(a), shared: a.parties.includes(me) }));
  if (self) return base;

  // opinione di me verso di lui (la propria riga: esatta, con i motivi)
  const out = opinionOf(s, me, actor);
  base.opinion.out = { value: out.value, band: bandIndex(out.value), base: baseOpinion(me, actor).reasons.map((r) => ({ ...r })), modifiers: out.modifiers.map((m) => modifierView(m, s.turn, weeks)).sort(byWeight) };
  // opinione di lui verso me: a fasce; esatta e con i motivi solo con intelligence
  const theirs = opinionOf(s, actor, me);
  base.opinion.in = {
    band: bandIndex(theirs.value),
    ...(hasIntel(s, me, actor) ? { exact: { value: theirs.value, base: baseOpinion(actor, me).reasons.map((r) => ({ ...r })), modifiers: theirs.modifiers.map((m) => modifierView(m, s.turn, weeks)).sort(byWeight) } } : {}),
    // gli atti pubblici (o rivolti a me) che pesano su di lui: solo le etichette, mai i valori
    known: theirs.modifiers.filter((m) => m.visibility === 'public' || m.visibility.includes(me)).sort((a, b) => b.turn - a.turn || a.label.localeCompare(b.label)).map((m) => ({ label: m.label, turnsLeft: turnsLeft(m, s.turn, weeks) })),
  };
  base.tension = r1(tensionOf(s, me, actor));
  base.ties = tieOf(s, me, actor) ?? null;
  base.embargo = { toThem: (d?.embargoes ?? []).includes(`${me}>${actor}`), toUs: (d?.embargoes ?? []).includes(`${actor}>${me}`) };
  const imp = (d?.improving ?? []).find((x) => x.actor === me && x.target === actor);
  base.improving = imp ? { since: imp.since } : null;

  const sanctioned = out.modifiers.some((m) => m.kind === 'sanction') || (d?.modifiers ?? []).some((m) => m.kind === 'sanction' && m.from === actor && m.to === me);
  base.actions = COUNTRY_ACTIONS.map((kind): ActionRow => {
    const info = actionInfo(s, me, sampleAction(kind, actor));
    const errors = [...info.errors];
    // «revoca» senza nulla da revocare: il motore l'accetta, ma l'interfaccia lo dice
    if (kind === 'LIFT_SANCTION' && !sanctioned) errors.push('nessuna sanzione in corso');
    const spec = DIPLO_CATALOG[kind];
    return { kind, label: info.label, cost: info.cost, coercive: !!spec.coercive, effects: spec.effects, cooldownUntil: info.cooldownUntil, available: errors.length === 0, errors };
  });
  base.proposals = PROPOSABLE.map(([type, label]): ProposalRow => {
    const proposal: DiploAction = { id: 'view', kind: 'PROPOSE_AGREEMENT', target: [actor], agreement: { type, parties: [me, actor], terms: '', endTurn: null, visibility: 'public' } };
    const info = actionInfo(s, me, proposal);
    const errors = [...info.errors];
    if (Object.values(s.agreements).some((a) => (a.status === 'active' || a.status === 'proposed') && a.type === type && a.parties.includes(me) && a.parties.includes(actor))) errors.push('un trattato dello stesso tipo è già in vigore o in attesa');
    const acc = acceptanceFor(s, me, actor, { type, parties: [me, actor] });
    return {
      kind: 'PROPOSE_AGREEMENT', variant: type, label, cost: AGREEMENT_COST[type] ?? info.cost, coercive: false, effects: DIPLO_CATALOG.PROPOSE_AGREEMENT.effects,
      cooldownUntil: info.cooldownUntil, available: errors.length === 0, errors, accept: acc.accept, score: acc.score, reasons: acc.reasons.map((r) => ({ ...r })), exact: acc.exact,
    };
  });
  return base;
}

// ——— votazioni ———

/**
 * Le votazioni pubbliche (eventi INSTITUTION_VOTE) con l'esito per Stato in ISO3. `dateOf` dà la data del turno. Compatto: tre elenchi di codici,
 * il testo della risoluzione tagliato; non c'è il motivo del voto di ciascuno Stato (quello è del motore).
 */
export function voteViews(events: GameEvent[], dateOf: (turn: number) => string | null): VoteView[] {
  return events.filter((e) => e.type === 'INSTITUTION_VOTE' && e.visibility === 'public').sort((a, b) => a.turn - b.turn || a.seq - b.seq).map((e) => {
    const p = e.payload as Record<string, any>;
    return {
      id: e.id, turn: e.turn, date: dateOf(e.turn), forum: String(p.forum), institutionId: String(p.institutionId), subject: String(p.subject ?? '').slice(0, 160), topic: String(p.topic ?? 'other'),
      proposer: String(p.proposer), target: p.target ? String(p.target) : null, passed: !!p.passed, rule: String(p.rule ?? ''), vetoes: (p.vetoes ?? []) as string[],
      yes: (p.yes ?? []) as string[], no: (p.no ?? []) as string[], abstain: (p.abstain ?? []) as string[],
    };
  });
}
