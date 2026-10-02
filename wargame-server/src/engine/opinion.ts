import type { Diplomacy, GameEvent, OpinionModifier, WorldState } from '../schemas/index.js';
import { OPINION_BANDS, type OpinionBand } from '../schemas/index.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Opinione asimmetrica (docs/wargame/DIPLOMAZIA.md §5): opinion(A→B) = quanto A apprezza B, da −100 a +100 =
 * clamp(base(A,B) + Σ modificatori(A→B)). Funziona per ogni coppia di attori: fazioni (id di fazione) e Stati del mondo (ISO3).
 * La base è una funzione pura dei dati del mondo, in cache in memoria e mai nello snapshot; i modificatori stanno in
 * `WorldState.diplomacy` e li cambiano solo gli eventi (OPINION_MODIFIER, OPINION_DECAYED).
 */
export interface OpinionReason { label: string; value: number }
export interface OpinionResult { value: number; reasons: OpinionReason[]; modifiers: OpinionModifier[] }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
export const emptyDiplomacy = (): Diplomacy => ({ modifiers: [], tension: {}, tensionBase: {} });

// ——— base statica ———

const baseCache = new Map<string, { value: number; reasons: OpinionReason[] }>();
/** Svuota la cache della base (per i test e la taratura che cambiano PARAMS.opinion.base). */
export const clearBaseOpinionCache = () => baseCache.clear();

/**
 * Base dell'opinione di `a` verso `b` dai dati del mondo: alleanza, unione, organizzazione regionale, blocchi contrapposti,
 * allineamento e voto ONU, regime, commercio e storia della coppia. Gli attori senza ISO3 (blocchi NATO/UE, LNA) valgono 0.
 */
export function baseOpinion(a: string, b: string): { value: number; reasons: OpinionReason[] } {
  const key = `${a}>${b}`;
  const hit = baseCache.get(key);
  if (hit) return hit;
  const w = worldData();
  const ia = w.isoOf(a); const ib = w.isoOf(b);
  const A = ia ? w.nation(ia) : undefined; const B = ib ? w.nation(ib) : undefined;
  const reasons: OpinionReason[] = [];
  const add = (label: string, value: number) => { const v = r1(value); if (v !== 0) reasons.push({ label, value: v }); };
  if (A && B && ia && ib && ia !== ib) {
    const P = PARAMS.opinion.base;
    const shared = w.institutions.filter((i) => i.members.includes(ia) && i.members.includes(ib));
    const defense = shared.filter((i) => i.effects.includes('collective_defense'));
    if (defense.length) add(`Alleanza difensiva in comune (${defense.map((i) => i.nameIt).join(', ')})`, P.alliance);
    const unions = shared.filter((i) => i.kind === 'union');
    if (unions.length) add(`Stessa unione (${unions.map((i) => i.nameIt).join(', ')})`, P.union);
    const regional = shared.filter((i) => i.kind === 'regional');
    if (regional.length) add(`Stessa organizzazione regionale (${regional.map((i) => i.nameIt).join(', ')})`, P.regional);
    for (const [x, y] of P.opposedBlocs) {
      const inX = (n: string) => w.institution(x)?.members.includes(n) ?? false; const inY = (n: string) => w.institution(y)?.members.includes(n) ?? false;
      if ((inX(ia) && inY(ib)) || (inY(ia) && inX(ib))) add(`Blocchi contrapposti (${w.institution(x)?.nameIt ?? x} e ${w.institution(y)?.nameIt ?? y})`, P.opposed);
    }
    // vicinanza di allineamento e di voto ONU
    const dA = (Math.abs(A.alignment.west - B.alignment.west) + Math.abs(A.alignment.china - B.alignment.china) + Math.abs(A.alignment.russia - B.alignment.russia)) / 2;
    const hasU = A.unIdealPoint !== undefined && B.unIdealPoint !== undefined;
    const D = hasU ? (1 - P.alignment.idealWeight) * dA + P.alignment.idealWeight * (Math.abs(A.unIdealPoint! - B.unIdealPoint!) / 2) : dA;
    add(hasU ? 'Allineamento e voto all\'ONU' : 'Allineamento', P.alignment.range * clamp((P.alignment.center - D) / P.alignment.span, -1, 1));
    add('Regimi politici', P.regime.range * clamp((P.regime.center - Math.abs(A.democracyScore - B.democracyScore)) / P.regime.span, -1, 1));
    const trade = A.topTrade.find((t) => t.iso3 === ib);
    if (trade) add('Dipendenza commerciale', Math.min(P.trade.max, trade.share * 100 * P.trade.perShare));
    const pair = w.pairValue(ia, ib);
    if (pair) add(pair.label, pair.value);
  }
  const out = { value: r1(reasons.reduce((n, r) => n + r.value, 0)), reasons };
  baseCache.set(key, out);
  return out;
}

// ——— opinione ———

/** `opinion(a→b)`: base più i modificatori vivi di a verso b, tra −100 e +100, con i motivi (base, poi modificatori). */
export function opinionOf(s: WorldState, a: string, b: string): OpinionResult {
  const base = baseOpinion(a, b);
  const modifiers = (s.diplomacy?.modifiers ?? []).filter((m) => m.from === a && m.to === b);
  const total = modifiers.reduce((n, m) => n + m.value, base.value);
  return { value: clamp(r1(total), -100, 100), reasons: [...base.reasons, ...modifiers.map((m) => ({ label: m.label, value: m.value }))], modifiers };
}

/** Fascia con cui si vede un'opinione (ostile · fredda · neutra · cordiale · stretta); soglie in PARAMS.opinion.bands. */
export function opinionBand(value: number): OpinionBand {
  const [t0, t1, t2, t3] = PARAMS.opinion.bands;
  return OPINION_BANDS[value < t0 ? 0 : value < t1 ? 1 : value < t2 ? 2 : value < t3 ? 3 : 4]!;
}

// ——— tensione di coppia ———

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Il fondo della tensione di una coppia: la tensione strutturale (predefinita 20) o, se maggiore, quella dettata dalla crisi più grave in comune. */
export function tensionBackground(s: WorldState, a: string, b: string): number {
  const T = PARAMS.opinion.tension;
  const base = s.diplomacy?.tensionBase[pairKey(a, b)] ?? T.default;
  let crisis = 0;
  for (const c of Object.values(s.crises)) if (c.status !== 'resolved' && c.involved.includes(a) && c.involved.includes(b)) crisis = Math.max(crisis, c.escalation * T.perCrisisLevel);
  return Math.max(base, crisis);
}
/** Tensione di una coppia (simmetrica): quella registrata se diversa dal fondo, altrimenti il fondo. */
export const tensionOf = (s: WorldState, a: string, b: string): number => s.diplomacy?.tension[pairKey(a, b)] ?? tensionBackground(s, a, b);

/** Imposta la tensione di una coppia; se coincide con il fondo la voce sparisce (si memorizza solo dove è diversa). */
export function setTension(s: WorldState, a: string, b: string, value: number) {
  const d = (s.diplomacy ??= emptyDiplomacy());
  const v = clamp(r1(value), 0, 100);
  if (Math.abs(v - tensionBackground(s, a, b)) < PARAMS.opinion.epsilon) delete d.tension[pairKey(a, b)]; else d.tension[pairKey(a, b)] = v;
}

// ——— valori derivati sulle relazioni tra fazioni ———

/** `relations[a][b].trust` e `.tension` restano per le coppie di fazioni come valori derivati da opinionOf e dalla tensione di coppia. */
export function syncRelation(s: WorldState, a: string, b: string) {
  const r = s.relations[a]?.[b];
  if (!r) return;
  r.trust = opinionOf(s, a, b).value;
  r.tension = r1(tensionOf(s, a, b));
}
export function syncPair(s: WorldState, a: string, b: string) { syncRelation(s, a, b); syncRelation(s, b, a); }
export function syncAll(s: WorldState) { for (const a of Object.keys(s.relations)) for (const b of Object.keys(s.relations[a]!)) syncRelation(s, a, b); }

// ——— costruzione dei modificatori ———

/** Atto diplomatico (un `relate()`): lo portano gli eventi che ne derivano, per chi legge gli incidenti, le minacce e le distensioni. */
export interface ActRef { id: string; a: string; b: string; note: string; incident?: boolean; detente?: boolean }

/**
 * Tabella nota → tipo di modificatore, in un posto solo: le note le scrivono diplomacy.ts, adjudication.ts e combat.ts. L'ordine conta
 * (la prima che corrisponde).
 */
const NOTE_KINDS: [RegExp, string][] = [
  [/^minaccia:/, 'threat'], [/^dichiarazione minacciosa/, 'statement_threat'], [/^dichiarazione conciliante/, 'statement_conciliatory'],
  [/^démarche:/, 'demarche'], [/^rassicurazione/, 'reassurance'], [/^canale riservato/, 'backchannel'], [/^lettera \(/, 'letter'],
  [/^sanzioni:/, 'sanction'], [/^revoca sanzioni:/, 'sanction_lifted'], [/^aiuto /, 'aid'],
  [/^risposta ad accordo .*: accept$/, 'agreement'], [/^risposta ad accordo /, 'agreement_rejected'],
  [/^(BLOCKADE|EXCLUSION_ZONE) in /, 'blockade'], [/^dimostrazione di forza in /, 'show_of_force'], [/^strike su /, 'strike'],
  [/^scontro in /, 'clash'], [/^incidente in /, 'incident'], [/^operazione clandestina scoperta/, 'sof'], [/^attacco cyber attribuito/, 'cyber'],
];
const TONE_LABEL: Record<string, string> = { cordial: 'cordiale', conciliatory: 'conciliante', formal: 'formale', firm: 'ferma', threatening: 'minacciosa' };

export function kindOfNote(note: string): { kind: string; label: string } {
  const kind = NOTE_KINDS.find(([re]) => re.test(note))?.[1] ?? 'incident';
  const tone = kind === 'letter' ? /^lettera \((\w+)\)/.exec(note)?.[1] : undefined;
  return { kind, label: kind === 'letter' && tone ? `Lettera ${TONE_LABEL[tone] ?? tone}` : PARAMS.opinion.modifiers[kind]!.label };
}

/**
 * Il modificatore per un'azione di `actor` verso `target`: modifica `opinion(target→actor)`. Quelli «sticky» (sanzioni) sono uno
 * per coppia e si accumulano fino al tetto; gli altri sono uno per atto (`seq` dell'atto) e decadono.
 */
export function buildModifier(s: WorldState, o: { kind: string; label: string; from: string; to: string; value: number; turn: number; act: string; causeRef: string; visibility: OpinionModifier['visibility']; decayPerWeek?: number }): OpinionModifier {
  const def = PARAMS.opinion.modifiers[o.kind]!;
  let value = r1(o.value);
  let id = `${o.kind}:${o.from}<${o.to}@${o.act}`;
  if (def.sticky) {
    id = `${o.kind}:${o.from}<${o.to}`;
    const cur = s.diplomacy?.modifiers.find((m) => m.id === id)?.value ?? 0;
    value = r1(def.cap !== undefined && def.cap < 0 ? Math.max(def.cap, cur + value) : Math.min(def.cap ?? Infinity, cur + value));
  }
  return { id, from: o.from, to: o.to, kind: o.kind, label: o.label, value, decayPerWeek: o.decayPerWeek ?? def.decayPerWeek, causeRef: o.causeRef, visibility: o.visibility, turn: o.turn };
}

/** Un atto che porta un OPINION_MODIFIER o un TENSION_CHANGED, normalizzato (vecchi RELATION_CHANGED compresi). */
export interface DiploAct { id: string; event: GameEvent; a: string; b: string; note: string; incident: boolean; detente: boolean }

/**
 * Gli atti diplomatici nei dati degli eventi, uno per atto: dai nuovi OPINION_MODIFIER e TENSION_CHANGED (campo `act`, solo quello
 * primario, mai le propagazioni agli alleati) e dai vecchi RELATION_CHANGED delle campagne precedenti. Lo leggono gli incidenti
 * (knowledge), gli inneschi delle lettere, le minacce da verificare e la distensione delle crisi.
 */
export function diploActs(events: GameEvent[]): DiploAct[] {
  const out: DiploAct[] = []; const seen = new Set<string>();
  for (const e of events) {
    const p = e.payload as Record<string, any>;
    if (e.type === 'RELATION_CHANGED') out.push({ id: e.id, event: e, a: String(p.a), b: String(p.b), note: String(p.note ?? ''), incident: !!p.incident, detente: !!p.detente });
    else if ((e.type === 'OPINION_MODIFIER' || e.type === 'TENSION_CHANGED') && p.act && !seen.has(p.act.id)) {
      seen.add(p.act.id);
      out.push({ id: p.act.id, event: e, a: p.act.a, b: p.act.b, note: String(p.act.note ?? ''), incident: !!p.act.incident, detente: !!p.act.detente });
    }
  }
  return out;
}

// ——— decadimento ———

export interface OpinionDecayChange { weeks: number; changed: [string, number][]; removed: string[] }

/**
 * Passo di decadimento dei modificatori (fase OPEN): il valore va verso 0 di decayPerWeek × settimane del turno; sotto `floor` (in
 * valore assoluto) non scende finché la causa è attiva; scaduti (expiresTurn) o quasi nulli si tolgono. Funzione pura: il motore ne
 * fa un solo evento OPINION_DECAYED.
 */
export function decayModifiers(mods: readonly OpinionModifier[], turn: number, weeks: number): OpinionDecayChange {
  const changed: [string, number][] = []; const removed: string[] = [];
  for (const m of mods) {
    if (m.expiresTurn !== undefined && turn >= m.expiresTurn) { removed.push(m.id); continue; }
    if (!m.decayPerWeek) continue;
    const sign = Math.sign(m.value);
    let mag = Math.max(0, Math.abs(m.value) - m.decayPerWeek * weeks);
    if (m.floor !== undefined && m.expiresTurn === undefined) mag = Math.max(mag, Math.min(Math.abs(m.value), Math.abs(m.floor)));
    const v = r1(sign * mag);
    if (Math.abs(v) < PARAMS.opinion.epsilon) removed.push(m.id); else if (v !== m.value) changed.push([m.id, v]);
  }
  return { weeks, changed, removed };
}

/** Passo della tensione di coppia verso il fondo: `[chiave, nuovo valore | null se coincide col fondo]`. */
export function decayTension(s: WorldState, weeks: number): [string, number | null][] {
  const out: [string, number | null][] = [];
  for (const [key, v] of Object.entries(s.diplomacy?.tension ?? {})) {
    const [a, b] = key.split('|') as [string, string];
    const bg = tensionBackground(s, a, b);
    const step = PARAMS.opinion.tension.decayPerWeek * weeks;
    const next = r1(v > bg ? Math.max(bg, v - step) : Math.min(bg, v + step));
    out.push([key, Math.abs(next - bg) < PARAMS.opinion.epsilon ? null : next]);
  }
  return out;
}

export const weeksOfTurn = (turnLength: 'week' | 'month') => PARAMS.opinion.weeksPerTurn[turnLength];

/**
 * Diplomazia iniziale di uno scenario: le coppie di `relations.pairs` (fiducia, tensione) diventano modificatori permanenti «Situazione 2026»
 * rispetto alla base dei dati del mondo (così i valori tarati finora restano), e la tensione strutturale diventa il fondo.
 */
export function initialDiplomacy(s: WorldState, pairs: [string, string, number, number][]): Diplomacy {
  const d: Diplomacy = emptyDiplomacy();
  s.diplomacy = d;
  const label = PARAMS.opinion.modifiers.situation!.label;
  for (const [x, y, trust, tension] of pairs) {
    for (const [a, b] of [[x, y], [y, x]] as const) {
      const value = r1(trust - baseOpinion(a, b).value);
      if (Math.abs(value) >= PARAMS.opinion.epsilon) d.modifiers.push({ id: `situation:${a}>${b}`, from: a, to: b, kind: 'situation', label, value, decayPerWeek: 0, causeRef: 'scenario', visibility: 'public', turn: 0 });
    }
    if (tension !== PARAMS.opinion.tension.default) d.tensionBase[pairKey(x, y)] = tension;
  }
  // la tensione iniziale delle coppie dello scenario è quella del file: dove il fondo (tensione strutturale o crisi) è diverso, si registra
  for (const [x, y, , tension] of pairs) setTension(s, x, y, tension);
  syncAll(s);
  return d;
}
