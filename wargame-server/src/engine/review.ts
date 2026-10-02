import type { Contact, GameEvent } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { evaluate } from './conditions.js';
import { diploActs } from './opinion.js';

const HOSTILE = /^(strike|sanzioni|BLOCKADE|EXCLUSION_ZONE|dimostrazione|scontro)/;

/** DEBRIEF: le minacce di due turni fa senza seguito ostile verso il bersaglio costano credibilità. */
export function checkThreats(ctx: TurnCtx, past: GameEvent[]) {
  const due = ctx.turn - 2;
  const all = [...past, ...ctx.events];
  for (const e of all.filter((x) => x.turn === due && x.type === 'FACTION_CHANGED' && (x.payload as { pendingThreat?: unknown }).pendingThreat)) {
    const { target } = (e.payload as { pendingThreat: { target: string } }).pendingThreat;
    const kept = diploActs(all).some((x) => x.event.turn >= due && x.a === e.actor && x.b === target && HOSTILE.test(x.note));
    if (!kept) ctx.emit('FACTION_CHANGED', e.actor, { factionId: e.actor, delta: { credibility: -4 }, note: `minaccia a ${target} non mantenuta` });
  }
}

/** DEBRIEF: avanzamento degli obiettivi (media mobile: 0.5 × precedente + 0.5 se la condizione è vera). */
export function updateObjectives(ctx: TurnCtx) {
  for (const f of Object.values(ctx.state.factions)) {
    if (!f.objectives.length) continue;
    const objectives = f.objectives.map((o) => ({ ...o, progress: +(o.progress * 0.5 + (evaluate(ctx.state, o.metric) ? 0.5 : 0)).toFixed(2) }));
    if (objectives.some((o, i) => o.progress !== f.objectives[i]!.progress)) ctx.emit('FACTION_CHANGED', f.id, { factionId: f.id, patch: { objectives } }, { visibility: [f.id] });
  }
}

/** INTEL: eventi di contatto nuovo/perso per fazione (solo id e classificazione, mai la verità). */
export function contactEvents(ctx: TurnCtx, previous: Record<string, Contact[]>) {
  for (const [f, now] of Object.entries(ctx.truthContacts)) {
    const before = new Set((previous[f] ?? []).map((c) => c.id));
    const ids = new Set(now.map((c) => c.id));
    for (const c of now.filter((c) => !before.has(c.id))) ctx.emit('CONTACT_DETECTED', f, { contactId: c.id, classification: c.classification, zoneId: c.zoneId, confidence: c.confidence }, { visibility: [f] });
    for (const c of (previous[f] ?? []).filter((c) => !ids.has(c.id))) ctx.emit('CONTACT_LOST', f, { contactId: c.id, classification: c.classification }, { visibility: [f] });
  }
}

/** INTEL: dopo un AAR le perdite nemiche diventano "confermate" solo se l'ISR del giocatore osserva la zona. */
export function confirmEnemyLosses(ctx: TurnCtx) {
  const player = ctx.campaign.playerFaction;
  const seen = new Map((ctx.truthContacts[player] ?? []).map((c) => [c.truthUnitId, c]));
  const covered = (zone: string) => ctx.state.factions[player]!.isrAssets.some((a) => a.coverage.includes(zone)) || Object.values(ctx.state.units).some((u) => u.factionId === player && u.zoneId === zone && u.status === 'deployed');
  for (const eng of Object.values(ctx.state.engagements)) {
    if (!eng.aar || eng.enemyLossesConfirmed || eng.turn >= ctx.turn || !covered(eng.zoneId)) continue;
    const enemies = eng.sides.filter((s) => s.factionId !== player).flatMap((s) => s.unitIds).map((id) => ctx.state.units[id]!);
    type Confirmed = { classification: string; status: 'destroyed' | 'damaged' | 'intact' };
    const confirmed = enemies.flatMap((u): Confirmed[] => {
      const c = seen.get(u.id);
      if (u.status === 'destroyed') return [{ classification: c?.classification ?? `unità ${u.domain} non più rilevata`, status: 'destroyed' }];
      return c ? [{ classification: c.classification, status: u.damage > 0 ? 'damaged' : 'intact' }] : [];
    });
    ctx.emit('ENGAGEMENT_RESOLVED', player, { engagementId: eng.id, patch: { enemyLossesConfirmed: confirmed } }, { visibility: [player] });
  }
}
