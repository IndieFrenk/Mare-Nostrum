import type { Agreement, WorldState } from '../schemas/index.js';
import { opinionOf } from './opinion.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Accettazione di una proposta di trattato (docs/wargame/DIPLOMAZIA.md §8): **deterministica** — niente dadi, deve essere spiegabile.
 * Il punteggio è la somma di motivi leggibili; accetta chi ottiene ≥ 0. Vale per tutti i destinatari: fazioni IA, Stati del mondo e, come
 * suggerimento nell'interfaccia, il giocatore. Lo legge anche il dry-run di `POST /validate`.
 */
export interface AcceptanceReason { label: string; value: number }
export interface AcceptanceResult { target: string; score: number; accept: boolean; reasons: AcceptanceReason[] }
export interface Proposal { type: Agreement['type']; parties: string[] }

/** Trattati di sicurezza: il destinatario ci mette la propria protezione, pesano la tensione del mondo e le alleanze esistenti. */
const SECURITY = new Set<string>(['defense', 'guarantee', 'defense_cooperation', 'military_access', 'basing', 'intel_sharing']);
/** Garanzie e alleanze: i piccoli le accettano volentieri dai grandi. */
const PROTECTION = new Set<string>(['defense', 'guarantee', 'defense_cooperation']);

const r1 = (v: number) => Math.round(v * 10) / 10;
const rejKey = (proposer: string, target: string, type: string) => `rej|${proposer}|${target}|${type}`;
export { rejKey };

const ACTIVE_SECURITY = (s: WorldState, who: string) => Object.values(s.agreements).filter((a) => a.status === 'active' && SECURITY.has(a.type) && a.parties.includes(who));

export function acceptance(s: WorldState, target: string, proposal: Proposal, proposer: string): AcceptanceResult {
  const P = PARAMS.acceptance; const w = worldData();
  const reasons: AcceptanceReason[] = [];
  const add = (label: string, value: number) => { const v = r1(value); if (v !== 0) reasons.push({ label, value: v }); };
  const it = w.isoOf(target); const ip = w.isoOf(proposer);
  const T = it ? w.nation(it) : undefined; const Pn = ip ? w.nation(ip) : undefined;
  const type = proposal.type;
  add(`Tipo di accordo: ${type}`, P.baseByType[type] ?? 0);
  add('Disponibilità di partenza', P.offset);
  const op = opinionOf(s, target, proposer).value;
  add(`Opinione verso il proponente (${Math.round(op)})`, op * P.opinionWeight);
  // allineamento: la distanza dei tre poli come nella base dell'opinione, con un peso minore
  if (T && Pn) {
    const D = (Math.abs(T.alignment.west - Pn.alignment.west) + Math.abs(T.alignment.china - Pn.alignment.china) + Math.abs(T.alignment.russia - Pn.alignment.russia)) / 2;
    add('Allineamento', P.alignmentRange * Math.max(-1, Math.min(1, (0.3 - D) / 0.4)));
  }
  // minaccia comune: il destinatario teme X e il proponente è rivale di X (alleati contro un nemico comune)
  const cand = [...Object.keys(s.factions).filter((f) => s.factions[f]!.kind !== 'bloc'), ...w.nations.filter((n) => !n.factionId).map((n) => n.iso3)];
  // (i più temuti per primi: somma delle due opinioni, a parità per id)
  const common = cand.filter((x) => x !== target && x !== proposer).map((x) => ({ x, o: opinionOf(s, target, x).value, p: opinionOf(s, proposer, x).value }))
    .filter((c) => c.o <= P.commonThreat.opinion && c.p <= P.commonThreat.opinion).sort((a, b) => a.o + a.p - (b.o + b.p) || a.x.localeCompare(b.x)).map((c) => c.x);
  if (common.length && SECURITY.has(type)) add(`Minaccia comune (${common.slice(0, 3).join(', ')}${common.length > 3 ? '…' : ''})`, Math.min(P.commonThreat.max, common.length * P.commonThreat.perRival));
  // dipendenza commerciale del destinatario dal proponente
  const trade = T?.topTrade.find((t) => t.iso3 === ip);
  if (trade) add('Dipendenza commerciale dal proponente', Math.min(P.tradeMax, trade.share * 100 * P.tradeWeight));
  // tensione mondiale: il mondo in tensione spinge verso la protezione e frena gli scambi
  const wt = s.globalIndicators.worldTension;
  if (SECURITY.has(type)) add(`Tensione mondiale (${Math.round(wt)})`, wt >= 55 ? P.worldTension.high : wt >= 40 ? P.worldTension.mid : wt < 25 ? P.worldTension.low : 0);
  else if (type === 'trade' && wt >= 55) add(`Tensione mondiale (${Math.round(wt)})`, P.worldTension.highTrade);
  // istituzioni in comune
  const shared = w.institutions.filter((i) => it && ip && i.members.includes(it) && i.members.includes(ip)).length;
  if (shared) add(`Istituzioni in comune (${shared})`, Math.min(P.sharedInstitutionMax, shared * P.sharedInstitution));
  // conflitto con trattati esistenti o con un rivale tra le parti
  const rivalOfProposer = (x: string) => x !== proposer && (opinionOf(s, proposer, x).value <= P.commonThreat.opinion || opinionOf(s, x, proposer).value <= P.commonThreat.opinion);
  const clash = SECURITY.has(type) ? ACTIVE_SECURITY(s, target).flatMap((a) => a.parties).find((x) => x !== target && rivalOfProposer(x)) : undefined;
  const enemyParty = proposal.parties.find((x) => x !== target && x !== proposer && opinionOf(s, target, x).value <= P.commonThreat.opinion);
  if (clash) add(`Conflitto con un trattato in vigore (${clash} è rivale del proponente)`, P.conflict);
  else if (enemyParty) add(`Tra le parti c'è un rivale (${enemyParty})`, P.conflict);
  // potenza relativa: i piccoli accettano garanzie dai grandi, i grandi le subiscono con freddezza
  if (T && Pn && PROTECTION.has(type)) {
    const ratio = Pn.gdpUsdB / Math.max(1, T.gdpUsdB);
    if (ratio >= P.smallPower.ratio) add('Il destinatario è molto più piccolo del proponente', P.smallPower.bonus);
    else if (ratio <= 1 / P.smallPower.ratio) add('Il proponente è molto più piccolo del destinatario', P.smallPower.big);
  }
  // tregua: la crisi in comune spinge ad accettarla
  if (type === 'ceasefire') {
    const esc = Math.max(0, ...Object.values(s.crises).filter((c) => c.status !== 'resolved' && c.involved.includes(target) && c.involved.includes(proposer)).map((c) => c.escalation));
    if (esc) add(`Crisi in comune (escalation ${Math.round(esc)})`, esc * P.ceasefirePerEscalation);
  }
  // credibilità del proponente
  const cred = s.factions[proposer]?.credibility;
  if (cred !== undefined) add(`Credibilità del proponente (${Math.round(cred)})`, Math.max(-P.credibility.max, Math.min(P.credibility.max, (cred - P.credibility.ref) * P.credibility.perPoint)));
  // proposta già respinta di recente
  if ((s.diplomacy?.cooldowns[rejKey(proposer, target, type)] ?? 0) > s.turn) add('Proposta già respinta di recente', P.recentlyRejected);
  const score = r1(reasons.reduce((a, r) => a + r.value, 0));
  return { target, score, accept: score >= 0, reasons };
}
