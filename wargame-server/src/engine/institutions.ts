import type { ResolutionForum, VoteTopic, WorldState } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { opinionOf } from './opinion.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Istituzioni e votazioni (docs/wargame/DIPLOMAZIA.md §9). Le regole di decisione vengono dal registro (`institutions.json`, campo
 * `decision`): CdS con veto dei membri permanenti, AG a maggioranza semplice dei votanti, UE a maggioranza qualificata (unanimità per la politica
 * estera), NATO e organizzazioni regionali per consenso. Il voto di ogni Stato è deterministico (`voteScore`): niente dadi, si spiega.
 */
export type Vote = 'yes' | 'no' | 'abstain';
export interface VoteInput { proposer: string; target?: string; topic: VoteTopic }
export interface VoteReason { label: string; value: number }

/** Sede della risoluzione → id dell'istituzione nel registro. */
export const INSTITUTION_OF: Record<ResolutionForum, string> = { UNSC: 'UNSC', UNGA: 'UNGA', EU_COUNCIL: 'EU', NATO: 'NATO', ARAB_LEAGUE: 'ARAB_LEAGUE', AU: 'AU' };

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Punteggio di voto di uno Stato (ISO3) su una proposta: ≥ `yesAt` sì, ≤ `noAt` no, in mezzo astensione. Con i motivi. */
export function voteScore(s: WorldState, iso: string, i: VoteInput): { score: number; vote: Vote; reasons: VoteReason[] } {
  const w = worldData(); const P = PARAMS.votes;
  const voter = w.actorOf(iso);
  const n = w.nation(iso);
  const reasons: VoteReason[] = [];
  const add = (label: string, value: number) => { if (Math.abs(value) >= 0.005) reasons.push({ label, value: r2(value) }); };
  if (voter === i.proposer) return { score: 1, vote: 'yes', reasons: [{ label: 'È il proponente', value: 1 }] };
  if (voter === i.target) return { score: -1, vote: 'no', reasons: [{ label: 'È il bersaglio della risoluzione', value: -1 }] };
  add('Opinione verso il proponente', P.weights.proposer * opinionOf(s, voter, i.proposer).value / 100);
  const iso0 = i.target ? w.isoOf(i.target) : undefined; const isoP = w.isoOf(i.proposer);
  const T = iso0 ? w.nation(iso0) : undefined; const Pn = isoP ? w.nation(isoP) : undefined;
  if (i.target) add('Opinione verso il bersaglio', -P.weights.target * opinionOf(s, voter, i.target).value / 100);
  if (n?.unIdealPoint !== undefined && T?.unIdealPoint !== undefined && Pn?.unIdealPoint !== undefined)
    add('Vicinanza sull\'asse del voto ONU', P.weights.ideal * (Math.abs(n.unIdealPoint - T.unIdealPoint) - Math.abs(n.unIdealPoint - Pn.unIdealPoint)) / 2);
  // coesione del blocco: l'alleanza (o l'unione) condivisa col bersaglio pesa contro, quella col proponente a favore
  let bloc = 0;
  for (const inst of w.institutions) {
    if (!(inst.effects.includes('collective_defense') || inst.kind === 'union') || !inst.members.includes(iso)) continue;
    if (iso0 && inst.members.includes(iso0)) bloc -= inst.cohesion;
    if (isoP && inst.members.includes(isoP)) bloc += inst.cohesion;
  }
  add('Coesione del blocco', P.weights.bloc * Math.max(-1, Math.min(1, bloc)));
  const [base, west] = P.topics[i.topic] ?? [0, 0];
  add(`Tema: ${i.topic}`, base + west * -(n?.unIdealPoint ?? 0));
  const score = r2(reasons.reduce((a, r) => a + r.value, 0));
  return { score, vote: score >= P.yesAt ? 'yes' : score <= P.noAt ? 'no' : 'abstain', reasons };
}

export interface VoteResult {
  forum: ResolutionForum; institutionId: string; rule: string; passed: boolean;
  /** ISO3 per esito del voto (compatto: tre elenchi) */
  yes: string[]; no: string[]; abstain: string[];
  /** membri permanenti del CdS che hanno votato no */
  vetoes: string[]; summary: string;
}

/** La regola di decisione di un'istituzione sui voti dati (funzione pura: la regola viene dal campo `decision` del registro). */
export function tally(institutionId: string, topic: VoteTopic, yes: string[], no: string[], abstain: string[]): { passed: boolean; rule: string; vetoes: string[] } {
  const w = worldData(); const P = PARAMS.votes;
  const inst = w.institution(institutionId);
  if (!inst) throw new Error(`istituzione sconosciuta ${institutionId}`);
  const vetoes = inst.decision === 'unsc' ? no.filter((x) => inst.leaders.includes(x)) : [];
  switch (inst.decision) {
    case 'unsc': return { passed: yes.length >= P.unscYes && !vetoes.length, rule: `${P.unscYes} voti su ${inst.members.length}, nessun veto dei permanenti`, vetoes };
    case 'majority': return { passed: yes.length > no.length, rule: 'maggioranza semplice dei votanti (gli astenuti non contano)', vetoes };
    case 'qmv': {
      if (!P.qmvTopics.includes(topic)) return { passed: no.length === 0, rule: 'unanimità (politica estera e sanzioni; l\'astensione non blocca)', vetoes };
      const pop = (l: string[]) => l.reduce((a, x) => a + (w.nation(x)?.population ?? 0), 0);
      return {
        passed: yes.length / inst.members.length >= P.qmv.states && pop(yes) / Math.max(1, pop(inst.members)) >= P.qmv.population,
        rule: `maggioranza qualificata (${Math.round(P.qmv.states * 100)}% degli Stati e ${Math.round(P.qmv.population * 100)}% della popolazione; gli astenuti contano come no)`, vetoes,
      };
    }
    default: return { passed: no.length === 0, rule: 'consenso (nessun voto contrario; l\'astensione non blocca)', vetoes };
  }
}

/** Votazione di una sede: ogni membro vota (`voteScore`), poi si applica la regola di decisione dell'istituzione (`tally`). */
export function runVote(s: WorldState, forum: ResolutionForum, i: VoteInput): VoteResult {
  const w = worldData(); const P = PARAMS.votes;
  const inst = w.institution(INSTITUTION_OF[forum]);
  if (!inst) throw new Error(`istituzione sconosciuta ${forum}`);
  const yes: string[] = []; const no: string[] = []; const abstain: string[] = [];
  for (const iso of [...inst.members].sort()) {
    const v = voteScore(s, iso, i);
    // il veto è un'arma: un permanente lo usa se è il bersaglio o ne è molto vicino, altrimenti si astiene
    const vote: Vote = inst.decision === 'unsc' && v.vote === 'no' && inst.leaders.includes(iso) && v.score > P.vetoAt && w.actorOf(iso) !== i.target ? 'abstain' : v.vote;
    ({ yes, no, abstain } as Record<Vote, string[]>)[vote].push(iso);
  }
  const t = tally(inst.id, i.topic, yes, no, abstain);
  return { forum, institutionId: inst.id, ...t, yes, no, abstain, summary: `${yes.length} sì, ${no.length} no, ${abstain.length} astenuti${t.vetoes.length ? `; veto di ${t.vetoes.join(', ')}` : ''}` };
}

/**
 * Una risoluzione (ordine RESOLUTION): votazione, evento INSTITUTION_VOTE con l'esito per Stato e, se approvata, la risoluzione che vale da
 * mandato per la legittimità (blocchi, zone di esclusione); effetti sull'opinione e la credibilità del proponente.
 */
export function resolveResolution(ctx: TurnCtx, actor: string, a: { id: string; forum: ResolutionForum; subject: string; topic: VoteTopic; target?: string }) {
  const s = ctx.state; const w = worldData(); const P = PARAMS.votes;
  const r = runVote(s, a.forum, { proposer: actor, ...(a.target ? { target: a.target } : {}), topic: a.topic });
  const resolution = r.passed ? { id: `RES-${ctx.turn}-${actor}-${a.id}`, forum: a.forum, institutionId: r.institutionId, subject: a.subject, topic: a.topic, proposer: actor, ...(a.target ? { target: a.target } : {}), turn: ctx.turn, expiresTurn: ctx.turn + PARAMS.diplo.legitimacy.resolutionTurns } : undefined;
  ctx.emit('INSTITUTION_VOTE', actor, {
    forum: a.forum, institutionId: r.institutionId, subject: a.subject, topic: a.topic, proposer: actor, target: a.target ?? null,
    passed: r.passed, rule: r.rule, yes: r.yes, no: r.no, abstain: r.abstain, vetoes: r.vetoes, ...(resolution ? { resolution } : {}),
  }, { targets: a.target ? [a.target] : [], causedBy: { orderId: a.id } });
  ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: r.passed ? P.credibilityPassed : P.credibilityFailed } }, { causedBy: { orderId: a.id } });
  // chi ha votato contro vede peggio il proponente (i più popolosi, fino al tetto: l'AG ha fino a 193 voti)
  const against = r.no.map((iso) => ({ iso, actor: w.actorOf(iso), pop: w.nation(iso)?.population ?? 0 }))
    .filter((x) => x.actor !== a.target && x.actor !== actor).sort((x, y) => y.pop - x.pop || x.iso.localeCompare(y.iso)).slice(0, P.maxModifiers);
  for (const x of against) ctx.relate(actor, x.actor, P.againstOpinion, 0, `voto contrario in ${r.institutionId}: ${a.subject}`, { propagate: false });
  if (r.passed && a.target) ctx.relate(actor, a.target, P.condemnation, P.condemnationTension, `condanna pubblica: ${a.subject}`, { propagate: false });
  return r;
}
