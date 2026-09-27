import type { FactionKnowledge, GameEvent, LedgerEntry, WorldState } from '../schemas/index.js';
import { BRIEFING_HEADINGS } from '../schemas/index.js';

export interface Fact { id: string; heading: string; text: string }
type H = (typeof BRIEFING_HEADINGS)[number];

/** Fatti numerici per il narratore, costruiti SOLO dalla Knowledge del giocatore e dagli eventi a lui visibili. */
export function briefingFacts(k: FactionKnowledge, recent: GameEvent[]): Fact[] {
  const facts: Fact[] = [];
  const add = (heading: H, text: string) => facts.push({ id: `F${k.turn}-${facts.length + 1}`, heading, text });
  for (const c of [...k.knownCrises].sort((a, b) => b.escalation - a.escalation)) add('Quadro strategico', `Crisi "${c.title}": escalation ${c.escalation}/10 (${c.status}).`);
  const hostile = Object.entries(k.beliefs).filter(([, b]) => b.estPosture <= 2);
  if (hostile.length) add('Quadro strategico', `Postura stimata ostile: ${hostile.map(([f]) => f).join(', ')}.`);
  const byZone = new Map<string, number>();
  for (const c of k.contacts) byZone.set(c.zoneId ?? '?', (byZone.get(c.zoneId ?? '?') ?? 0) + 1);
  add('Tracce e movimenti', `${k.contacts.length} contatti attivi, di cui ${k.contacts.filter((c) => c.firstSeenTurn === k.turn).length} nuovi.`);
  for (const [z, n] of [...byZone].sort((a, b) => b[1] - a[1]).slice(0, 4)) add('Tracce e movimenti', `${z}: ${n} contatti.`);
  for (const c of k.contacts.filter((c) => c.confidence >= 0.6 && c.estFaction !== 'unknown' && ['RUS', 'IRN', 'TUR', 'LBY_LNA', 'CHN'].includes(c.estFaction)).slice(0, 5))
    add('Allarmi intelligence', `${c.classification} attribuito a ${c.estFaction} in ${c.zoneId}, confidenza ${Math.round(c.confidence * 100)}%.`);
  for (const e of recent.filter((e) => e.type === 'RANDOM_EVENT' || e.type === 'RED_LINE_CROSSED' || e.type === 'CYBER_EFFECT').slice(0, 5)) add('Allarmi intelligence', String((e.payload as { text?: string }).text ?? e.type));
  for (const m of k.inbox.slice(0, 3)) add('Quadro strategico', `Messaggio da ${m.from}: ${m.text}`);
  const g = k.ownFaction;
  add('Energia e rotte', `Stato infrastrutture critiche monitorato; crisi Mar Rosso a ${k.knownCrises.find((c) => c.id === 'RED_SEA')?.escalation ?? 0}/10.`);
  const deployed = k.ownUnits.filter((u) => u.status === 'deployed' || u.status === 'transit');
  const avg = Math.round(k.ownUnits.filter((u) => u.status !== 'destroyed').reduce((a, u) => a + u.readiness, 0) / Math.max(1, k.ownUnits.length));
  add('Stato FOED e prontezza', `FOED disponibile: ${g.budget.discretionary} M€.`);
  add('Stato FOED e prontezza', `${deployed.length} unità schierate o in transito; prontezza media ${avg}%.`);
  const dmg = k.ownUnits.filter((u) => u.status === 'damaged' || u.status === 'maintenance');
  if (dmg.length) add('Stato FOED e prontezza', `${dmg.length} unità in manutenzione o danneggiate.`);
  return facts;
}

export function energyFacts(s: WorldState, turn: number): Fact[] {
  const g = s.globalIndicators;
  const out: Fact[] = [{ id: `F${turn}-E1`, heading: 'Energia e rotte', text: `TTF ${g.ttfEurMwh} €/MWh, Brent ${g.brentUsd} $, rischio navigazione ${g.medShippingRisk}/100, pressione migratoria ${g.migrationPressure}/100.` }];
  for (const i of Object.values(s.infrastructure).filter((i) => i.status !== 'operational')) out.push({ id: `F${turn}-E-${i.id}`, heading: 'Energia e rotte', text: `${i.name}: ${i.status}.` });
  return out;
}

export function debriefFacts(turn: number, events: GameEvent[], ledger: LedgerEntry[], player: string): Fact[] {
  const facts: Fact[] = [];
  const add = (heading: string, text: string) => facts.push({ id: `D${turn}-${facts.length + 1}`, heading, text });
  const spent = ledger.filter((l) => l.factionId === player && l.amount < 0).reduce((a, l) => a + l.amount, 0);
  const last = ledger.filter((l) => l.factionId === player).at(-1);
  add('Economia', `Spese del turno: ${Math.round(-spent * 10) / 10} M€; saldo FOED ${last?.balanceAfter ?? 'invariato'} M€.`);
  for (const e of events) {
    const p = e.payload as Record<string, any>;
    if (e.type === 'ENGAGEMENT_OPENED') add('Operazioni', `Ingaggio ${p.engagement.id} in ${p.engagement.zoneId} (${p.engagement.scale}).`);
    if (e.type === 'ENGAGEMENT_RESOLVED' && p.patch?.autoResult) add('Operazioni', `Esito ${p.engagementId}: ${p.patch.autoResult.summary}.`);
    if (e.type === 'UNIT_DAMAGED' && e.visibility !== 'public' && e.visibility.includes(player)) add('Usura e perdite', `Unità ${p.unitId} danneggiata (${p.damage}%).`);
    if (e.type === 'CRISIS_CHANGED' && p.delta) add('Diplomazia e crisi', `Crisi ${p.crisisId}: ${p.delta > 0 ? '+' : ''}${p.delta} (${p.cause}).`);
    if (e.type === 'STATEMENT' && p.kind) add('Diplomazia e crisi', `${p.kind} su "${p.subject}": ${p.passed ? 'approvato' : 'respinto'} (${p.yes}/${p.total}).`);
    if (e.type === 'DELIVERY_ARRIVED' && e.actor === player) add('Economia', `Consegna ${p.deliveryId} arrivata.`);
    if (e.type === 'RANDOM_EVENT') add('Diplomazia e crisi', String(p.text));
  }
  return facts.slice(0, 40);
}
