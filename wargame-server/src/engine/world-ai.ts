import type { Directive, DiploAction, DiploLetter, GraveEvent, LetterTone, Reaction, WorldDecision, WorldState } from '../schemas/index.js';
import { LETTER_LIMITS } from '../schemas/index.js';
import type { Nation } from '../schemas/nations.js';
import { acceptance } from './acceptance.js';
import { checkAction } from './diplo-actions.js';
import { opinionLookup } from './opinion.js';
import { PARAMS } from './params.js';
import type { Rng } from './rng.js';
import type { WorldDigest } from './world-digest.js';
import { viewOf } from './world-digest.js';
import { worldData } from './world-data.js';

/**
 * IA mondiale (livello C, docs/wargame/DIPLOMAZIA.md §10): tutti gli Stati senza fazione, a regole e senza LLM. Funzione pura sullo stato e sul
 * digest pubblico del turno precedente, con il dado registrato (`rng`) e in ordine di ISO3: stesso seed → stesse decisioni, il replay le ricalcola.
 * Cinque attività: reazioni agli atti pubblici gravi, voti (nel settore 09: qui il collegamento sono le sanzioni di blocco), risposte alle proposte
 * (le fazioni agli Stati del mondo si risolvono già in aggiudicazione, con acceptance()), sanzioni di blocco e agenda lenta sfalsata.
 * Nebbia: ogni Stato vede solo `viewOf(digest, suo id)`; mai la verità di terra.
 */
export interface WorldAiInput {
  state: WorldState; digest: WorldDigest; player: string; rng: Rng; playerLettersPrev: DiploLetter[];
  /**
   * Direttive in vigore delle grandi potenze (§11, già limitate dal motore; facoltative: senza, nessun effetto). Una potenza che vuole `improve` o `court`
   * uno Stato del mondo ne fa un partner più probabile per quello Stato: il bonus di punteggio entra nella scelta del partner prioritario dell'agenda.
   */
  directives?: { faction: string; directive: Directive }[];
}
export interface WorldLetterTrigger { iso: string; kind: 'reply' | 'initiative'; trigger?: string; tone: LetterTone; gist: string; replyTo?: DiploLetter }
export type WorldAiOutput = Pick<WorldDecision, 'actions' | 'reactions' | 'blockSanctions' | 'rationale' | 'stats'> & { letterTriggers: WorldLetterTrigger[] };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const nameOf = (actor: string, s: WorldState) => s.factions[actor]?.name ?? worldData().nation(actor)?.nameIt ?? actor;
/** id dell'attore di ogni Stato del registro (la fazione se c'è, altrimenti l'ISO3) */
const actorOfNation = (n: Nation) => n.factionId ?? n.iso3;

/** Gli Stati del mondo: quelli del registro senza fazione, in ordine di ISO3 (l'indice decide lo sfalsamento dell'agenda). */
export const worldStates = (): Nation[] => worldData().nations.filter((n) => !n.factionId);

// ——— reazioni ———

/** Coesione dei blocchi (alleanza o unione) che due Stati hanno in comune, 0–1. */
function blocScore(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  return Math.min(1, worldData().institutions.filter((i) => (i.effects.includes('collective_defense') || i.kind === 'union') && i.members.includes(a) && i.members.includes(b)).reduce((n, i) => n + i.cohesion, 0));
}

/**
 * Simpatia di un Stato verso la vittima rispetto all'attore dell'atto, da −1 a +1: opinione, vicinanza sull'asse del voto ONU e coesione dei
 * blocchi in comune. Positiva → condanna l'attore, negativa → lo sostiene.
 */
export function sympathy(op: (a: string, b: string) => number, who: { iso: string; actor: string }, a: string, v: string): number {
  const W = PARAMS.worldAi.reaction.weights; const w = worldData();
  const isoA = w.isoOf(a); const isoV = w.isoOf(v);
  const nR = w.nation(who.iso); const nA = isoA ? w.nation(isoA) : undefined; const nV = isoV ? w.nation(isoV) : undefined;
  const ideal = nR?.unIdealPoint !== undefined && nA?.unIdealPoint !== undefined && nV?.unIdealPoint !== undefined
    ? (Math.abs(nR.unIdealPoint - nA.unIdealPoint) - Math.abs(nR.unIdealPoint - nV.unIdealPoint)) / 2 : 0;
  return W.opinion * (op(who.actor, v) - op(who.actor, a)) / 100 + W.ideal * ideal + W.bloc * (blocScore(who.iso, isoV) - blocScore(who.iso, isoA));
}

/** Reazione di tutti gli Stati a un atto grave pubblico: condanna, sostegno o silenzio per ISO3, e i modificatori (aggregati, con un tetto). */
export function reactTo(s: WorldState, op: (a: string, b: string) => number, ev: GraveEvent, player: string): Reaction {
  const R = PARAMS.worldAi.reaction; const w = worldData();
  const condemn: string[] = []; const support: string[] = []; const silent: string[] = [];
  const reactors: { n: Nation; actor: string; how: 'condemn' | 'support' }[] = [];
  for (const n of w.nations) {
    const actor = actorOfNation(n);
    if (actor === ev.a || actor === ev.b || actor === player || s.factions[actor]?.controller === 'human') continue;
    const sym = sympathy(op, { iso: n.iso3, actor }, ev.a, ev.b);
    if (sym >= R.threshold) { condemn.push(n.iso3); reactors.push({ n, actor, how: 'condemn' }); }
    else if (sym <= -R.threshold) { support.push(n.iso3); reactors.push({ n, actor, how: 'support' }); }
    else silent.push(n.iso3);
  }
  // i modificatori: prima le fazioni (le vedono il giocatore e le regole), poi gli Stati più popolosi, fino al tetto
  const kindOf = (x: string) => s.factions[x]?.kind;
  const modifiers: Reaction['modifiers'] = [];
  const order = [...reactors].sort((x, y) => Number(!!y.n.factionId) - Number(!!x.n.factionId) || y.n.population - x.n.population || x.n.iso3.localeCompare(y.n.iso3));
  for (const r of order) {
    const m: Reaction['modifiers'] = r.how === 'condemn'
      ? [{ from: ev.a, to: r.actor, kind: 'condemnation', value: -R.opinion }, { from: ev.b, to: r.actor, kind: 'support', value: R.opinion }]
      : [{ from: ev.a, to: r.actor, kind: 'support', value: R.opinion }];
    const ok = m.filter((x) => kindOf(x.from) !== 'bloc');
    if (modifiers.length + ok.length > R.maxModifiersPerEvent) break;
    modifiers.push(...ok);
  }
  return { eventId: ev.id, kind: ev.kind, actor: ev.a, victim: ev.b, severity: ev.severity, ...(ev.zoneId ? { zoneId: ev.zoneId } : {}), condemn, support, silent, modifiers };
}

// ——— sanzioni di blocco ———

/** Istituzioni le cui sanzioni vincolano i membri (UE, ECOWAS, CdS per tutti gli Stati ONU): quelle non vincolanti (AG, UA, Lega Araba…) no. */
const BINDING = ['common_sanctions', 'veto_members'];

/**
 * Se un'istituzione ha approvato sanzioni contro un bersaglio, i membri che hanno votato sì si adeguano con probabilità = coesione
 * dell'istituzione (tiro registrato, in ordine di ISO3); il CdS vincola tutti gli Stati ONU con un'opinione del bersaglio non amichevole.
 */
function blockSanctions(s: WorldState, d: WorldDigest, op: (a: string, b: string) => number, rng: Rng): WorldDecision['blockSanctions'] {
  const w = worldData(); const B = PARAMS.worldAi.blockSanctions;
  const out: WorldDecision['blockSanctions'] = [];
  for (const v of d.votes.filter((x) => x.passed && x.topic === 'sanctions' && x.target)) {
    const inst = w.institution(v.institutionId);
    if (!inst || !inst.effects.some((e) => BINDING.includes(e))) continue;
    const target = v.target!;
    const pool = (inst.id === 'UNSC' ? w.membersOf('UNGA') : inst.members).filter((iso) => inst.id === 'UNSC' ? true : v.yes.includes(iso)).sort();
    const adopters: string[] = []; const holdouts: string[] = [];
    for (const iso of pool) {
      const n = w.nation(iso);
      if (!n || n.factionId || iso === v.proposer || iso === target || w.actorOf(iso) === target) continue;
      if (inst.id === 'UNSC' && op(iso, target) > 25) { holdouts.push(iso); continue; }
      if (adopters.length >= B.maxAdopters) { holdouts.push(iso); continue; }
      (rng.chance(`adeguamento alle sanzioni ${v.id}: ${iso}`, inst.cohesion).ok ? adopters : holdouts).push(iso);
    }
    if (adopters.length) out.push({ voteId: v.id, target, adopters, holdouts });
  }
  return out;
}

// ——— agenda lenta ———

interface Cand { actor: string; action: DiploAction; target: string; text: string }

/** Il partner prioritario di uno Stato: commercio, blocchi in comune, vicinanza di allineamento; le fazioni e il giocatore contano un po' di più. */
export function partnersOf(s: WorldState, n: Nation, player: string, dirs: WorldAiInput['directives'] = []): { actor: string; score: number }[] {
  const w = worldData(); const A = PARAMS.worldAi.agenda.partner;
  const score = new Map<string, number>();
  const add = (actor: string, v: number) => { if (actor !== n.iso3) score.set(actor, (score.get(actor) ?? 0) + v); };
  for (const t of n.topTrade) { const x = w.nation(t.iso3); if (x) add(actorOfNation(x), t.share * 100 * A.perTradePoint); }
  for (const inst of w.institutions) if (inst.members.includes(n.iso3) && (inst.effects.includes('collective_defense') || inst.kind === 'union' || inst.kind === 'regional'))
    for (const l of inst.leaders) { const x = w.nation(l); if (x && l !== n.iso3) add(actorOfNation(x), A.perSharedBloc); }
  add(player, 0);
  // una potenza che vuole avvicinare questo Stato (direttiva): per lui è un partner più probabile, in proporzione al peso
  for (const { faction, directive } of dirs) for (const p of directive.priorities) if ((p.kind === 'improve' || p.kind === 'court') && (p.target === n.iso3 || p.target === actorOfNation(n))) add(faction, p.weight * A.directive);
  const out: { actor: string; score: number }[] = [];
  for (const [actor, base] of score) {
    const iso = w.isoOf(actor); const x = iso ? w.nation(iso) : undefined;
    const D = x ? (Math.abs(n.alignment.west - x.alignment.west) + Math.abs(n.alignment.china - x.alignment.china) + Math.abs(n.alignment.russia - x.alignment.russia)) / 2 : 0.5;
    out.push({ actor, score: base + A.alignment * clamp(1 - D / 0.6, 0, 1) + (s.factions[actor] ? A.faction : 0) + (actor === player ? A.player : 0) });
  }
  return out.sort((a, b) => b.score - a.score || a.actor.localeCompare(b.actor));
}

/** Opinione «in calo»: chi ha un modificatore recente e negativo (non permanente) verso lo Stato, con un'opinione di base non ostile. */
function decliningIndex(s: WorldState, turn: number): Map<string, { from: string; value: number }[]> {
  const A = PARAMS.worldAi.agenda; const out = new Map<string, { from: string; value: number }[]>();
  for (const m of s.diplomacy?.modifiers ?? []) {
    if (m.decayPerWeek === 0 || m.value > A.decliningMin || m.turn < turn - A.decliningWithin || m.kind === 'situation' || m.kind === 'history') continue;
    (out.get(m.to) ?? out.set(m.to, []).get(m.to)!).push({ from: m.from, value: m.value });
  }
  return out;
}

const idOf = (iso: string, turn: number, n: number) => `${iso}-${turn}-W${n}`;

function agenda(i: WorldAiInput, op: (a: string, b: string) => number, rationale: WorldAiOutput['rationale']): { actions: WorldDecision['actions']; stats: WorldDecision['stats'] } {
  const s = i.state; const A = PARAMS.worldAi.agenda; const turn = s.turn;
  const states = worldStates();
  const declining = decliningIndex(s, turn);
  const cands: Cand[] = [];
  let eligible = 0;
  states.forEach((n, idx) => {
    if ((idx + turn) % A.every !== 0) return;
    eligible++;
    const actor = n.iso3;
    const mine = viewOf(i.digest, actor);
    const valid = (a: DiploAction) => checkAction(s, actor, a).length === 0;
    const partners = partnersOf(s, n, i.player, i.directives);
    const improving = s.diplomacy?.improving.filter((x) => x.actor === actor) ?? [];
    const nm = (x: string) => nameOf(x, s);
    const pick = (): Cand | null => {
      // 0) relazioni consolidate: libera lo slot
      const done = improving.find((x) => op(actor, x.target) >= 60);
      if (done) return { actor, action: { id: idOf(actor, turn, 1), kind: 'STOP_IMPROVE', target: done.target }, target: done.target, text: `Relazioni con ${nm(done.target)} consolidate: ${nm(actor)} libera lo slot` };
      // 1) un rivale che ha compiuto un atto ostile: richiamo dell'ambasciatore (tiro registrato)
      // (solo atti molto gravi e solo se lo Stato prende le parti della vittima: sympathy ≥ soglia, come nelle reazioni)
      const hostile = [...new Set(mine.filter((e) => e.severity >= A.recallSeverity && e.a !== actor && e.b !== actor && sympathy(op, { iso: actor, actor }, e.a, e.b) >= PARAMS.worldAi.reaction.threshold).map((e) => e.a))]
        .filter((x) => op(actor, x) <= A.rival).sort((x, y) => op(actor, x) - op(actor, y) || x.localeCompare(y));
      for (const x of hostile) {
        const a: DiploAction = { id: idOf(actor, turn, 2), kind: 'RECALL_AMBASSADOR', target: x };
        if (valid(a) && i.rng.chance(`agenda ${actor}: richiamo dell'ambasciatore da ${x}`, A.recallChance).ok) return { actor, action: a, target: x, text: `${nm(actor)} richiama l'ambasciatore da ${nm(x)} dopo un atto ostile (opinione ${Math.round(op(actor, x))})` };
      }
      // 2) chi ha di recente peggiorato la sua opinione di noi, senza essere un nemico: rassicurazione
      const down = (declining.get(actor) ?? []).filter((x) => x.from !== actor && s.factions[x.from]?.kind !== 'bloc' && op(x.from, actor) > A.rival).sort((x, y) => x.value - y.value || x.from.localeCompare(y.from))[0];
      if (down) {
        const a: DiploAction = { id: idOf(actor, turn, 3), kind: 'REASSURANCE', target: down.from, message: `Il Governo di ${nm(actor)} conferma a ${nm(down.from)} la volontà di cooperare e di evitare ogni incomprensione.`, visibility: 'public' };
        if (valid(a)) return { actor, action: a, target: down.from, text: `${nm(down.from)} vede peggio ${nm(actor)} (−${Math.abs(down.value)}): rassicurazione` };
      }
      // 3) accordo commerciale con il partner prioritario che lo accetterebbe
      const trades = Object.values(s.agreements).filter((x) => x.type === 'trade' && x.status !== 'expired' && x.parties.includes(actor)).length;
      for (const p of trades >= A.maxTrade ? [] : partners.slice(0, 3)) {
        if (op(actor, p.actor) < A.tradeFrom) continue;
        if (Object.values(s.agreements).some((x) => x.type === 'trade' && x.status !== 'expired' && x.parties.includes(actor) && x.parties.includes(p.actor))) continue;
        const a: DiploAction = { id: idOf(actor, turn, 4), kind: 'PROPOSE_AGREEMENT', target: [p.actor], agreement: { type: 'trade', parties: [actor, p.actor], terms: `Accordo commerciale tra ${nm(actor)} e ${nm(p.actor)}`, endTurn: null, visibility: 'public' } };
        if (!valid(a)) continue;
        const acc = acceptance(s, p.actor, { type: 'trade', parties: [actor, p.actor] }, actor);
        if (acc.accept) return { actor, action: a, target: p.actor, text: `Partner prioritario ${nm(p.actor)} (opinione ${Math.round(op(actor, p.actor))}): proposta di accordo commerciale, che accetterebbe (punteggio ${acc.score})` };
      }
      // 4) migliorare le relazioni con il partner prioritario dall'opinione ancora bassa
      for (const p of partners.slice(0, 3)) {
        if (op(actor, p.actor) >= A.improveBelow || improving.some((x) => x.target === p.actor)) continue;
        const a: DiploAction = { id: idOf(actor, turn, 5), kind: 'IMPROVE_RELATIONS', target: p.actor };
        if (valid(a)) return { actor, action: a, target: p.actor, text: `Partner prioritario ${nm(p.actor)} con opinione ${Math.round(op(actor, p.actor))}: migliorare le relazioni` };
      }
      return null;
    };
    const c = pick();
    if (c) cands.push(c);
  });
  // tetto globale: prima le azioni verso le fazioni e il giocatore, poi per tipo e per ISO3
  const rank = (c: Cand) => [s.factions[c.target] ? 1 : 0, c.target === i.player ? 1 : 0, A.priority[c.action.kind] ?? 0] as const;
  cands.sort((a, b) => { const x = rank(a); const y = rank(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || a.actor.localeCompare(b.actor); });
  const kept = cands.slice(0, A.maxActionsPerTurn);
  for (const c of kept) rationale.push({ rule: 'agenda', actor: c.actor, text: c.text });
  if (cands.length > kept.length) rationale.push({ rule: 'cap', text: `Tetto globale di ${A.maxActionsPerTurn} azioni a turno: ${cands.length - kept.length} azioni dell'agenda rimandate` });
  return { actions: kept.map((c) => ({ actor: c.actor, action: c.action })), stats: { eligible, candidates: cands.length, capped: cands.length - kept.length } };
}

// ——— lettere al giocatore ———

/** Chi scrive al giocatore: la risposta a una sua lettera, oppure un innesco forte (ultimatum o sanzioni subite, accordo accettato). */
function letterTriggers(i: WorldAiInput): WorldLetterTrigger[] {
  const s = i.state; const w = worldData();
  const isState = (x: string) => !!w.nation(x) && !w.nation(x)!.factionId;
  const nm = (x: string) => nameOf(x, s);
  const out: WorldLetterTrigger[] = [];
  const gist = (t: string) => t.slice(0, LETTER_LIMITS.gist);
  for (const l of i.playerLettersPrev) if (l.from === i.player && isState(l.to)) out.push({ iso: l.to, kind: 'reply', tone: 'formal', gist: gist(`Rispondere alla lettera del governo italiano «${l.subject}».`), replyTo: l });
  for (const e of i.digest.events) {
    if (e.kind === 'ultimatum' && e.a === i.player && isState(e.b)) out.push({ iso: e.b, kind: 'initiative', trigger: 'ultimatum', tone: 'firm', gist: gist(`Rispondere con fermezza all'ultimatum dell'Italia e chiedere di tornare al dialogo.`) });
    if ((e.kind === 'sanction' || e.kind === 'multilateral_sanction' || e.kind === 'embargo') && e.b === i.player && isState(e.a)) out.push({ iso: e.a, kind: 'initiative', trigger: 'sanction', tone: 'formal', gist: gist(`Spiegare all'Italia le misure di ${nm(e.a)} (${e.kind === 'embargo' ? 'embargo sulle armi' : 'sanzioni'}) e lasciare aperta la strada del dialogo.`) });
  }
  for (const a of i.digest.accepted) if (a.proposer === i.player) for (const p of a.parties.filter((x) => x !== i.player && isState(x)))
    out.push({ iso: p, kind: 'initiative', trigger: 'agreement', tone: 'cordial', gist: gist(`Confermare l'impegno sull'accordo (${a.type}) appena entrato in vigore con l'Italia e proporne l'attuazione.`) });
  const seen = new Set<string>();
  const rank = { reply: 0, ultimatum: 1, sanction: 2, agreement: 3 } as Record<string, number>;
  return out.sort((x, y) => (rank[x.trigger ?? 'reply'] ?? 9) - (rank[y.trigger ?? 'reply'] ?? 9) || x.iso.localeCompare(y.iso))
    .filter((t) => !seen.has(t.iso) && !!seen.add(t.iso));
}

/** Il turno dell'IA mondiale: reazioni, sanzioni di blocco, agenda lenta e chi vuole scrivere al giocatore. */
export function worldAiTurn(i: WorldAiInput): WorldAiOutput {
  const op = opinionLookup(i.state);
  const rationale: WorldAiOutput['rationale'] = [];
  const reactions = i.digest.events.filter((e) => e.severity >= PARAMS.worldAi.reactionSeverity).slice(0, PARAMS.worldAi.maxReactedEvents).map((e, n) => {
    // gli elenchi di tutti gli eventi gravi (al massimo `maxReactedEvents`), i modificatori d'opinione solo per i più gravi (`modifiedEvents`)
    const r = reactTo(i.state, op, e, i.player);
    if (n >= PARAMS.worldAi.reaction.modifiedEvents) r.modifiers = [];
    rationale.push({ rule: 'reaction', text: `${nameOf(e.a, i.state)} → ${nameOf(e.b, i.state)} (${e.kind}, gravità ${e.severity}): condannano ${r.condemn.length}, sostengono ${r.support.length}, in silenzio ${r.silent.length}` });
    return r;
  });
  const bs = blockSanctions(i.state, i.digest, op, i.rng);
  for (const b of bs) rationale.push({ rule: 'block_sanction', text: `Sanzioni contro ${nameOf(b.target, i.state)} (${b.voteId}): si adeguano ${b.adopters.length}, no ${b.holdouts.length}` });
  const { actions, stats } = agenda(i, op, rationale);
  return { actions, reactions, blockSanctions: bs, rationale, stats, letterTriggers: letterTriggers(i) };
}

/** Il profilo di uno Stato del mondo per il ruolo diplomat (parole, niente cifre: non finiscono tra i fatti ammessi della lettera). */
export function stateProfile(n: Nation): string {
  const gov: Record<string, string> = { democracy: 'democrazia', hybrid: 'regime ibrido', authoritarian: 'regime autoritario', absolute_monarchy: 'monarchia assoluta', theocracy: 'teocrazia', military: 'governo militare', transitional: 'governo di transizione' };
  const mem = worldData().institutions.filter((x) => x.members.includes(n.iso3) && ['NATO', 'EU', 'CSTO', 'BRICS', 'SCO', 'ARAB_LEAGUE', 'AU', 'ASEAN', 'OIC'].includes(x.id)).map((x) => x.nameIt).join(', ');
  return `Stato: ${n.nameIt}. Governo: ${gov[n.government] ?? n.government}.${mem ? ` Appartenenze: ${mem}.` : ''}`;
}

