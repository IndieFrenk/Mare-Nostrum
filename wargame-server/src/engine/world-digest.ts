import type { DigestVote, GameEvent, GraveEvent } from '../schemas/index.js';
import { diploActs } from './opinion.js';
import { PARAMS } from './params.js';

/**
 * Il digest pubblico del turno (docs/wargame/DIPLOMAZIA.md §10): quello che gli Stati del mondo sanno del turno precedente. Si costruisce **una
 * volta sola** dagli eventi, invece di una Knowledge su file per ognuno dei 197 Stati. Gli eventi **pubblici** gravi stanno in `events` (ognuno ne
 * vede tutti); gli atti non pubblici stanno in `involving` solo per gli attori a cui erano destinati (`visibility`): uno Stato non vede
 * mai ciò che non è pubblico e non lo riguarda (nebbia di guerra). Niente verità di terra: solo ciò che è finito negli eventi pubblici.
 */
export interface WorldDigest {
  turn: number;
  /** atti pubblici gravi, dal più grave (poi per id) */
  events: GraveEvent[];
  /** atti non pubblici che riguardano un attore (destinatario): per attore */
  involving: Record<string, GraveEvent[]>;
  /** decisioni pubbliche delle istituzioni */
  votes: DigestVote[];
  /** accordi entrati in vigore nel turno (pubblici): chi li ha proposti e le altre parti */
  accepted: { id: string; type: string; parties: string[]; proposer: string }[];
}

/** nota dell'atto (scritta da diplomacy.ts, adjudication.ts, combat.ts) → tipo di atto grave */
const NOTE_KIND: [RegExp, GraveEvent['kind']][] = [
  [/^strike su /, 'strike'], [/^scontro in /, 'engagement'], [/^(BLOCKADE|EXCLUSION_ZONE) in /, 'blockade'], [/^ultimatum:/, 'ultimatum'],
  [/^sanzioni:/, 'sanction'], [/^rottura delle relazioni/, 'break'], [/^embargo sulle armi:/, 'embargo'],
  [/^attacco cyber attribuito/, 'cyber'], [/^operazione clandestina scoperta/, 'covert'],
];

const isPublic = (e: GameEvent) => e.visibility === 'public';

/** Gli eventi del turno (di solito quelli del turno precedente) → il digest. Funzione pura: il replay lo ricostruisce identico. */
export function buildDigest(events: GameEvent[], turn: number): WorldDigest {
  const grave = new Map<string, GraveEvent>();
  const involving: Record<string, GraveEvent[]> = {};
  const publicEvents: GraveEvent[] = [];
  for (const act of diploActs([...events].sort((x, y) => x.seq - y.seq))) {
    const kind = NOTE_KIND.find(([re]) => re.test(act.note))?.[1];
    if (!kind) continue;
    const zoneId = / in ([A-Z_]+)$/.exec(act.note)?.[1] ?? / in ([A-Z_]+):/.exec(act.note)?.[1];
    const g: GraveEvent = { id: act.id, kind, a: act.a, b: act.b, severity: PARAMS.worldAi.severity[kind], turn: act.event.turn, ...(zoneId ? { zoneId } : {}), text: act.note.slice(0, 120) };
    const vis = act.event.visibility;
    if (vis === 'public') {
      // lo stesso atto ripetuto (stessa zona o stesso bersaglio) conta una volta
      const key = `${kind}|${act.a}|${act.b}|${zoneId ?? ''}`;
      if (!grave.has(key)) { grave.set(key, g); publicEvents.push(g); }
    } else for (const who of vis) (involving[who] ??= []).push(g);
  }
  const votes: DigestVote[] = [];
  const accepted: WorldDigest['accepted'] = [];
  for (const e of events) {
    const p = e.payload as Record<string, any>;
    if (e.type === 'INSTITUTION_VOTE' && isPublic(e)) {
      votes.push({ id: e.id, turn: e.turn, forum: p.forum, institutionId: p.institutionId, proposer: p.proposer, ...(p.target ? { target: p.target } : {}), topic: p.topic, subject: String(p.subject ?? '').slice(0, 120), passed: !!p.passed, yes: p.yes ?? [], no: p.no ?? [], abstain: p.abstain ?? [] });
      // le sanzioni approvate da un'istituzione sono un atto grave multilaterale contro il bersaglio
      if (p.passed && p.topic === 'sanctions' && p.target) publicEvents.push({ id: e.id, kind: 'multilateral_sanction', a: p.proposer, b: p.target, severity: PARAMS.worldAi.severity.multilateral_sanction, turn: e.turn, text: `sanzioni approvate in ${p.institutionId}`.slice(0, 120) });
    }
    if (e.type === 'AGREEMENT_CHANGED' && isPublic(e) && p.agreement?.status === 'active') accepted.push({ id: p.agreement.id, type: p.agreement.type, parties: p.agreement.parties, proposer: p.agreement.parties[0] });
  }
  publicEvents.sort((x, y) => y.severity - x.severity || x.id.localeCompare(y.id));
  return { turn, events: publicEvents, involving, votes, accepted };
}

/** Ciò che l'attore `who` vede del digest: gli atti pubblici più quelli che lo riguardano; mai quelli non pubblici di altri. */
export function viewOf(d: WorldDigest, who: string): GraveEvent[] {
  return [...d.events, ...(d.involving[who] ?? [])];
}
